const { setGlobalOptions } = require("firebase-functions");
const { onRequest } = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const express = require("express");

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

const app = express();
app.use(express.json());

// 개별 푸시 보내기
app.post("/", async (req, res) => {
  try {
    const { token, title, body } = req.body;
    logger.info("req.body:", req.body);

    if (!token || !title || !body) {
      return res.status(400).send("token, title, body가 필요합니다.");
    }

    const message = {
      notification: { title, body },
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

// 전체 사용자에게 푸시 보내기
app.post("/broadcast", async (req, res) => {
  try {
    const { title, body } = req.body;

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

    // 500개씩 나눠서 전송
    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batchTokens = tokens.slice(i, i + BATCH_SIZE);

      const message = {
        notification: { title, body },
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

    res.status(200).json({ successCount, failureCount, failedTokens });
  } catch (error) {
    logger.error("전체 푸시 전송 실패:", error);
    res.status(500).send("전체 푸시 전송 실패");
  }
});

exports.sendPush = onRequest(app);
