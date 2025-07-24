const functions = require("firebase-functions");
const { onRequest } = functions.https;
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const express = require("express");
exports.scheduledPush = require("./scheduledPush").scheduledPush;

// ✅ 이미 초기화된 경우 다시 하지 않음
if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://web-push-test-mhlee-default-rtdb.firebaseio.com",
  });
}
functions.setGlobalOptions({
  maxInstances: 10,
});

const app = express();
const cors = require("cors");
app.use(cors());
app.use(express.json());

// 개별 푸시 보내기
app.post("/", async (req, res) => {
  try {
    let { token, title, body, userId, receiverId } = req.body;
    logger.info("req.body:", req.body);
    let senderId = userId;

    if (!token || !title || !body) {
      return res.status(400).send("token, title, body가 필요합니다.");
    }

    senderId = typeof senderId === "string" && senderId.trim() !== "" ? senderId : "관리자";
    receiverId = typeof receiverId === "string" && receiverId.trim() !== "" ? receiverId : "unknown";

    const message = {
      data: { title, body },
      token,
    };

    const response = await admin.messaging().send(message);
    logger.info("푸시 전송 성공:", response);

    // DB 저장 (보낸사람 / 받는사람 기록)
    await admin.database().ref("/pushMessages").push({
      senderId,
      receiverIds: [receiverId], // 단일 수신자라도 배열로 저장
      title,
      body,
      timestamp: Date.now(),
    });

    res.status(200).send("푸시 전송 성공");
  } catch (error) {
    logger.error("푸시 전송 실패:", error);
    res.status(500).send("푸시 전송 실패");
  }
});


app.post("/broadcast/all", async (req, res) => {
  try {
    const { title, body, userId } = req.body;
    const senderId = userId;

    if (!title || !body) {
      return res.status(400).send("title, body가 필요합니다.");
    }

    // RTDB에서 userTokens 읽기
    const snapshot = await admin.database().ref("/userTokens").once("value");

    if (!snapshot.exists()) {
      return res.status(404).send("토큰 데이터가 없습니다.");
    }

    const tokensData = snapshot.val();

    // tokensData 구조에 맞게 fcmToken만 추출
    const tokens = Object.values(tokensData)
      .map((item) => item.fcmToken)
      .filter((token) => typeof token === "string" && token.length > 0);

    if (tokens.length === 0) {
      return res.status(404).send("유효한 토큰이 없습니다.");
    }

    const BATCH_SIZE = 500;
    let successCount = 0;
    let failureCount = 0;
    const failedTokens = [];

    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batchTokens = tokens.slice(i, i + BATCH_SIZE);

      const message = {
        data: { title, body },
        tokens: batchTokens,
      };

      const response = await admin.messaging().sendEachForMulticast(message);

      successCount += response.successCount;
      failureCount += response.failureCount;

      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          failedTokens.push(batchTokens[idx]);
        }
      });
    }

    logger.info(`전체 푸시 완료: 성공 ${successCount}, 실패 ${failureCount}`);
    if (failedTokens.length > 0) {
      logger.warn("푸시 실패한 토큰:", failedTokens);
    }

    // 푸시 발송 기록 저장
    const receiverIds = Object.values(tokensData)
      .map((item) => item.id)
      .filter((id) => typeof id === "string" && id.length > 0);

    await admin.database().ref("/pushMessages").push({
      senderId: typeof senderId === "string" && senderId.length > 0 ? senderId : "관리자",
      receiverIds,
      title,
      body,
      timestamp: Date.now(),
    });

    res.status(200).json({ successCount, failureCount, failedTokens });
  } catch (error) {
    logger.error("전체 푸시 전송 실패:", error);
    res.status(500).send("전체 푸시 전송 실패");
  }
});


app.post("/broadcast", async (req, res) => {
  try {
    const { title, body, userId } = req.body;
    const senderId = userId;

    if (!title || !body) {
      return res.status(400).send("title, body가 필요합니다.");
    }

    // userInfos 조회
    const userInfosSnap = await admin.database().ref("/userInfos").once("value");
    if (!userInfosSnap.exists()) {
      return res.status(404).send("userInfos가 비어 있습니다.");
    }

    const userInfos = userInfosSnap.val();

    const targetUserIds = Object.entries(userInfos)
      .filter(([_, userData]) =>
        typeof userData.groups === "object" &&
        userData.groups["클라이언트"] === true,
      )
      .map(([userKey]) => userKey);

    if (targetUserIds.length === 0) {
      return res.status(404).send("클라이언트 그룹 사용자가 없습니다.");
    }

    // userTokens에서 해당 유저들의 FCM 토큰 추출
    const tokensSnap = await admin.database().ref("/userTokens").once("value");
    const tokensData = tokensSnap.exists() ? tokensSnap.val() : {};

    const tokens = Object.values(tokensData)
      .filter((entry) => targetUserIds.includes(entry.id))
      .map((entry) => entry.fcmToken)
      .filter((token) => typeof token === "string" && token.length > 0);

    if (tokens.length === 0) {
      return res.status(404).send("해당 그룹에 유효한 푸시 토큰이 없습니다.");
    }

    // 푸시 전송
    const BATCH_SIZE = 500;
    let successCount = 0;
    let failureCount = 0;
    const failedTokens = [];

    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batchTokens = tokens.slice(i, i + BATCH_SIZE);
      const message = {
        data: { title, body },
        tokens: batchTokens,
      };

      const response = await admin.messaging().sendEachForMulticast(message);

      successCount += response.successCount;
      failureCount += response.failureCount;

      response.responses.forEach((resp, idx) => {
        if (!resp.success) failedTokens.push(batchTokens[idx]);
      });
    }

    logger.info(`클라이언트 그룹 푸시 완료: 성공 ${successCount}, 실패 ${failureCount}`);

    // ✅ 푸시 발송 기록 저장
    await admin.database().ref("/pushMessages").push({
      senderId: typeof senderId === "string" && senderId.trim() !== "" ? senderId : "관리자",
      receiverIds: targetUserIds,
      title,
      body,
      timestamp: Date.now(),
    });

    res.status(200).json({ successCount, failureCount, failedTokens });
  } catch (error) {
    logger.error("클라이언트 그룹 푸시 실패:", error);
    res.status(500).send("클라이언트 그룹 푸시 실패");
  }
});


app.post("/broadcast/users", async (req, res) => {
  try {
    const { ids, title, body, userId } = req.body;
    const senderId = userId;

    if (!Array.isArray(ids) || ids.length === 0 || !title || !body) {
      return res.status(400).send("ids (배열), title, body가 필요합니다.");
    }

    // RTDB에서 userTokens 가져오기
    const tokensSnap = await admin.database().ref("/userTokens").once("value");
    const tokensData = tokensSnap.exists() ? tokensSnap.val() : {};

    // 선택된 ID 목록에 해당하는 토큰만 추출
    const tokens = Object.values(tokensData)
      .filter((entry) => ids.includes(entry.id))
      .map((entry) => entry.fcmToken)
      .filter((token) => typeof token === "string" && token.length > 0);

    if (tokens.length === 0) {
      return res.status(404).send("해당 ID에 해당하는 유효한 푸시 토큰이 없습니다.");
    }

    // 푸시 전송
    const BATCH_SIZE = 500;
    let successCount = 0;
    let failureCount = 0;
    const failedTokens = [];

    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batchTokens = tokens.slice(i, i + BATCH_SIZE);
      const message = {
        data: { title, body },
        tokens: batchTokens,
      };

      const response = await admin.messaging().sendEachForMulticast(message);

      successCount += response.successCount;
      failureCount += response.failureCount;

      response.responses.forEach((resp, idx) => {
        if (!resp.success) failedTokens.push(batchTokens[idx]);
      });
    }

    logger.info(`지정 사용자 푸시 완료: 성공 ${successCount}, 실패 ${failureCount}`);

    // ✅ 푸시 발송 기록 저장
    await admin.database().ref("/pushMessages").push({
      senderId: typeof senderId === "string" && senderId.trim() !== "" ? senderId : "관리자",
      receiverIds: ids,
      title,
      body,
      timestamp: Date.now(),
    });

    res.status(200).json({ successCount, failureCount, failedTokens });
  } catch (error) {
    logger.error("지정 사용자 푸시 실패:", error);
    res.status(500).send("지정 사용자 푸시 실패");
  }
});

app.post("/broadcast/group", async (req, res) => {
  try {
    const { title, body, groups, userId } = req.body;

    const senderId = userId;

    if (!title || !body || !Array.isArray(groups) || groups.length === 0) {
      return res.status(400).send("title, body, groups 배열이 필요합니다.");
    }

    // userInfos 조회
    const userInfosSnap = await admin.database().ref("/userInfos").once("value");
    if (!userInfosSnap.exists()) {
      return res.status(404).send("userInfos가 비어 있습니다.");
    }

    const userInfos = userInfosSnap.val();

    // groups 중 하나라도 true인 유저 필터링
    const targetUserIds = Object.entries(userInfos)
      .filter(([_, userData]) =>
        typeof userData.groups === "object" &&
        groups.some((groupName) => userData.groups[groupName] === true),
      )
      .map(([userKey]) => userKey);

    if (targetUserIds.length === 0) {
      return res.status(404).send("해당 그룹 사용자들이 없습니다.");
    }

    // userTokens 조회
    const tokensSnap = await admin.database().ref("/userTokens").once("value");
    const tokensData = tokensSnap.exists() ? tokensSnap.val() : {};

    const tokens = Object.values(tokensData)
      .filter((entry) => targetUserIds.includes(entry.id))
      .map((entry) => entry.fcmToken)
      .filter((token) => typeof token === "string" && token.length > 0);

    if (tokens.length === 0) {
      return res.status(404).send("해당 그룹의 유효한 푸시 토큰이 없습니다.");
    }

    // 푸시 전송
    const BATCH_SIZE = 500;
    let successCount = 0;
    let failureCount = 0;
    const failedTokens = [];

    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batchTokens = tokens.slice(i, i + BATCH_SIZE);
      const message = {
        data: { title, body },
        tokens: batchTokens,
      };

      const response = await admin.messaging().sendEachForMulticast(message);

      successCount += response.successCount;
      failureCount += response.failureCount;

      response.responses.forEach((resp, idx) => {
        if (!resp.success) failedTokens.push(batchTokens[idx]);
      });
    }

    logger.info(
      `그룹 푸시 완료 (groups: ${groups.join(", ")}): 성공 ${successCount}, 실패 ${failureCount}`,
    );

    // ✅ 푸시 발송 기록 저장
    await admin.database().ref("/pushMessages").push({
      senderId: typeof senderId === "string" && senderId.trim() !== "" ? senderId : "관리자",
      receiverGroups: groups,
      receiverIds: targetUserIds,
      title,
      body,
      timestamp: Date.now(),
    });

    res.status(200).json({ successCount, failureCount, failedTokens });
  } catch (error) {
    logger.error("그룹 푸시 실패:", error);
    res.status(500).send("그룹 푸시 실패");
  }
});

app.get("/push/history/:userId", async (req, res) => {
  const userId = req.params.userId;

  try {
    const snapshot = await admin.database().ref("/pushMessages").once("value");
    if (!snapshot.exists()) {
      return res.status(200).json([]);
    }

    const result = [];
    snapshot.forEach((child) => {
      const data = child.val();
      const isSender = data.senderId === userId;
      const isReceiver = Array.isArray(data.receiverIds) && data.receiverIds.includes(userId);

      if (isSender || isReceiver) {
        result.push({
          id: child.key,
          ...data,
          direction: isSender ? "sent" : "received",
        });
      }
    });

    // 최신순 정렬
    result.sort((a, b) => b.timestamp - a.timestamp);

    res.status(200).json(result);
  } catch (err) {
    logger.error("푸시 히스토리 조회 실패:", err);
    res.status(500).send("푸시 히스토리 조회 실패");
  }
});

exports.sendPush = onRequest(app);
