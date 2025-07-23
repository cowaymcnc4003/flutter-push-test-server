const { onSchedule } = require("firebase-functions/v2/scheduler");
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
dayjs.extend(utc);

// ✅ 여기서도 꼭 중복 초기화 방지!
if (!admin.apps.length) {
  admin.initializeApp();
}

// 요일 매핑 (일~토)
const weekDayKorMap = ["일", "월", "화", "수", "목", "금", "토"];

exports.scheduledPush = onSchedule(
  { schedule: "0,30 * * * *", timeZone: "Asia/Seoul" },
  async (event) => {
    console.log("30분 정각마다 실행되는 스케줄 함수");

    const now = dayjs().utcOffset(9); // 한국시간 기준
    const today = now.format("YYYY-MM-DD");
    const currentTime = now.format("HH:mm");
    const todayWeekDayKor = weekDayKorMap[now.day()];
    const db = admin.database();

    try {
      const schedulesSnap = await db.ref("/pushSchedules").once("value");
      if (!schedulesSnap.exists()) return null;

      const schedules = schedulesSnap.val();

      const dueSchedules = Object.values(schedules).filter((s) => {
        if (s.isSent && s.repeat === "none") return false; // 단발성이고 이미 전송 완료
        if (today < s.startTime || today > s.endTime) return false;
        if (s.scheduleAt !== currentTime) return false;

        if (s.repeat === "daily") return true;

        if (s.repeat === "weekly") {
          if (!Array.isArray(s.scheduleDays)) return false;
          return s.scheduleDays.includes(todayWeekDayKor);
        }

        // repeat 없거나 none일 경우 오늘이 startTime인 경우만 전송
        if (!s.repeat || s.repeat === "none") {
          return today === s.startTime;
        }

        return false;
      });

      if (dueSchedules.length === 0) return null;

      const userTokensSnap = await db.ref("/userTokens").once("value");
      const userTokens = userTokensSnap.exists() ? userTokensSnap.val() : {};

      const userInfosSnap = await db.ref("/userInfos").once("value");
      const userInfos = userInfosSnap.exists() ? userInfosSnap.val() : {};

      for (const schedule of dueSchedules) {
        let tokens = [];

        if (schedule.target === "All") {
          tokens = Object.values(userTokens).map((u) => u.fcmToken);
        } else {
          // 그룹 필터링
          const targetUserIds = Object.entries(userInfos)
            .filter(([_, user]) => user.groups && user.groups[schedule.target] === true)
            .map(([key]) => key);

          tokens = Object.values(userTokens)
            .filter((t) => targetUserIds.includes(t.id))
            .map((t) => t.fcmToken);
        }

        tokens = tokens.filter((token) => typeof token === "string" && token.length > 0);

        if (tokens.length === 0) {
          functions.logger.warn(`푸시 대상 없음: ${schedule.title}`);
          continue;
        }

        const message = {
          pushData: {
            title: schedule.title,
            body: schedule.message,
          },
          tokens,
        };

        const res = await admin.messaging().sendEachForMulticast(message);

        functions.logger.info(
          `푸시 전송 완료: ${schedule.title} / ${currentTime} / 성공 ${res.successCount}, 실패 ${res.failureCount}`,
        );

        // 단일 전송일 경우에만 isSent 마킹
        if (!schedule.repeat || schedule.repeat === "none") {
          await db.ref(`/pushSchedules/${schedule.id}/isSent`).set(true);
        }
      }

      return null;
    } catch (err) {
      functions.logger.error("스케줄 푸시 오류", err);
      return null;
    }
  },
);
