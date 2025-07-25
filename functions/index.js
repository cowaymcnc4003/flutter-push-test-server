const functions = require("firebase-functions");
const { onRequest } = functions.https;
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const express = require("express");
exports.scheduledPush = require("./scheduledPush").scheduledPush;

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

const MAX_ALLOWED_RECORDS = 1000000; // 100만 건 제한

/**
 * 지정된 RTDB 경로의 자식 노드(레코드) 개수를 비동기로 조회합니다.
 * @param {string} path - RTDB 경로
 * @return {Promise<number>} - 해당 경로 하위 자식 노드 개수
 */
async function checkDataCount(path) {
  const snapshot = await admin.database().ref(path).once("value");
  if (!snapshot.exists()) return 0;
  return snapshot.numChildren();
}

// 개별 푸시 보내기
app.post("/", async (req, res) => {
  try {
    // 제한체크 (예: /userTokens 수 체크 필요없으면 생략 가능)
    // const userTokensCount = await checkDataCount("/userTokens");
    // if (userTokensCount >= MAX_ALLOWED_RECORDS) {
    //   return res.status(403).send("데이터 용량 초과로 읽기/쓰기 제한됨");
    // }

    const { token, title, body } = req.body;
    logger.info("req.body:", req.body);

    if (!token || !title || !body) {
      return res.status(400).send("token, title, body가 필요합니다.");
    }

    const message = {
      data: { title, body },
      token,
    };

    const response = await admin.messaging().send(message);
    logger.info("푸시 전송 성공:", response);

    res.status(200).send("푸시 전송 성공");
  } catch (error) {
    logger.error("푸시 전송 실패:", error);
    res.status(500).send("푸시 전송 실패");
  }
});

// 전체 사용자 대상 푸시
app.post("/broadcast/all", async (req, res) => {
  try {
    // 100만 건 제한 체크
    const userTokensCount = await checkDataCount("/userTokens");
    if (userTokensCount >= MAX_ALLOWED_RECORDS) {
      return res.status(403).send("데이터 용량 초과로 읽기/쓰기 제한됨");
    }

    const { title, body, id } = req.body;
    const senderId = id;

    if (!title || !body) {
      return res.status(400).send("title, body가 필요합니다.");
    }

    const snapshot = await admin.database().ref("/userTokens").once("value");
    if (!snapshot.exists()) {
      return res.status(404).send("토큰 데이터가 없습니다.");
    }

    const tokensData = snapshot.val();

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

    const receiverIds = Object.values(tokensData)
      .map((item) => item.id)
      .filter((id) => typeof id === "string" && id.length > 0);

    const uniqueReceiverIds = [...new Set(receiverIds)];

    await admin.database().ref("/pushMessages").push({
      senderId: typeof senderId === "string" && senderId.length > 0 ? senderId : "관리자",
      receiverIds: uniqueReceiverIds,
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

// 클라이언트 그룹 푸시
app.post("/broadcast", async (req, res) => {
  try {
    // 100만 건 제한 체크
    const userInfosCount = await checkDataCount("/userInfos");
    if (userInfosCount >= MAX_ALLOWED_RECORDS) {
      return res.status(403).send("데이터 용량 초과로 읽기/쓰기 제한됨");
    }

    const { title, body, id } = req.body;
    const senderId = id;

    if (!title || !body) {
      return res.status(400).send("title, body가 필요합니다.");
    }

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

    const tokensSnap = await admin.database().ref("/userTokens").once("value");
    const tokensData = tokensSnap.exists() ? tokensSnap.val() : {};

    const tokens = Object.values(tokensData)
      .filter((entry) => targetUserIds.includes(entry.id))
      .map((entry) => entry.fcmToken)
      .filter((token) => typeof token === "string" && token.length > 0);

    if (tokens.length === 0) {
      return res.status(404).send("해당 그룹에 유효한 푸시 토큰이 없습니다.");
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
        if (!resp.success) failedTokens.push(batchTokens[idx]);
      });
    }

    logger.info(`클라이언트 그룹 푸시 완료: 성공 ${successCount}, 실패 ${failureCount}`);

    const uniqueReceiverIds = [...new Set(targetUserIds)];

    await admin.database().ref("/pushMessages").push({
      senderId: typeof senderId === "string" && senderId.trim() !== "" ? senderId : "관리자",
      receiverIds: uniqueReceiverIds,
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

// 지정 사용자 푸시
app.post("/broadcast/users", async (req, res) => {
  try {
    // 100만 건 제한 체크
    const userTokensCount = await checkDataCount("/userTokens");
    if (userTokensCount >= MAX_ALLOWED_RECORDS) {
      return res.status(403).send("데이터 용량 초과로 읽기/쓰기 제한됨");
    }

    const { ids, title, body, id } = req.body;
    const senderId = id;

    if (!Array.isArray(ids) || ids.length === 0 || !title || !body) {
      return res.status(400).send("ids (배열), title, body가 필요합니다.");
    }

    const tokensSnap = await admin.database().ref("/userTokens").once("value");
    const tokensData = tokensSnap.exists() ? tokensSnap.val() : {};

    const tokens = Object.values(tokensData)
      .filter((entry) => ids.includes(entry.id))
      .map((entry) => entry.fcmToken)
      .filter((token) => typeof token === "string" && token.length > 0);

    if (tokens.length === 0) {
      return res.status(404).send("해당 ID에 해당하는 유효한 푸시 토큰이 없습니다.");
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
        if (!resp.success) failedTokens.push(batchTokens[idx]);
      });
    }

    logger.info(`지정 사용자 푸시 완료: 성공 ${successCount}, 실패 ${failureCount}`);

    const uniqueReceiverIds = [...new Set(ids)];

    await admin.database().ref("/pushMessages").push({
      senderId: typeof senderId === "string" && senderId.trim() !== "" ? senderId : "관리자",
      receiverIds: uniqueReceiverIds,
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

// 그룹 푸시
app.post("/broadcast/group", async (req, res) => {
  try {
    // 100만 건 제한 체크
    const userInfosCount = await checkDataCount("/userInfos");
    if (userInfosCount >= MAX_ALLOWED_RECORDS) {
      return res.status(403).send("데이터 용량 초과로 읽기/쓰기 제한됨");
    }

    const { title, body, groups, id } = req.body;

    const senderId = id;

    if (!title || !body || !Array.isArray(groups) || groups.length === 0) {
      return res.status(400).send("title, body, groups 배열이 필요합니다.");
    }

    const userInfosSnap = await admin.database().ref("/userInfos").once("value");
    if (!userInfosSnap.exists()) {
      return res.status(404).send("userInfos가 비어 있습니다.");
    }

    const userInfos = userInfosSnap.val();

    const targetUserIds = Object.entries(userInfos)
      .filter(([_, userData]) =>
        typeof userData.groups === "object" &&
        groups.some((groupName) => userData.groups[groupName] === true),
      )
      .map(([userKey]) => userKey);

    if (targetUserIds.length === 0) {
      return res.status(404).send("해당 그룹 사용자들이 없습니다.");
    }

    const tokensSnap = await admin.database().ref("/userTokens").once("value");
    const tokensData = tokensSnap.exists() ? tokensSnap.val() : {};

    const tokens = Object.values(tokensData)
      .filter((entry) => targetUserIds.includes(entry.id))
      .map((entry) => entry.fcmToken)
      .filter((token) => typeof token === "string" && token.length > 0);

    if (tokens.length === 0) {
      return res.status(404).send("해당 그룹의 유효한 푸시 토큰이 없습니다.");
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
        if (!resp.success) failedTokens.push(batchTokens[idx]);
      });
    }

    logger.info(
      `그룹 푸시 완료 (groups: ${groups.join(", ")}): 성공 ${successCount}, 실패 ${failureCount}`,
    );

    const uniqueReceiverIds = [...new Set(targetUserIds)];

    await admin.database().ref("/pushMessages").push({
      senderId: typeof senderId === "string" && senderId.trim() !== "" ? senderId : "관리자",
      receiverGroups: groups,
      receiverIds: uniqueReceiverIds,
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

// 푸시 히스토리 조회
app.post("/push/history", async (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).send("id가 필요합니다.");
  }

  try {
    // 제한 체크 - 히스토리 저장 개수도 너무 많으면 차단 가능
    const pushMessagesCount = await checkDataCount("/pushMessages");
    if (pushMessagesCount >= MAX_ALLOWED_RECORDS) {
      return res.status(403).send("데이터 용량 초과로 읽기/쓰기 제한됨");
    }

    const snapshot = await admin.database().ref("/pushMessages").once("value");
    if (!snapshot.exists()) {
      return res.status(200).json([]);
    }

    const result = [];
    snapshot.forEach((child) => {
      const data = child.val();
      const isSender = data.senderId === id;
      const isReceiver = Array.isArray(data.receiverIds) && data.receiverIds.includes(id);

      if (isSender || isReceiver) {
        result.push({
          id: child.key,
          ...data,
          direction: isSender ? "sent" : "received",
        });
      }
    });

    result.sort((a, b) => b.timestamp - a.timestamp);

    res.status(200).json(result);
  } catch (err) {
    logger.error("푸시 히스토리 조회 실패:", err);
    res.status(500).send("푸시 히스토리 조회 실패");
  }
});

exports.sendPush = onRequest(app);
