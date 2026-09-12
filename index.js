require("dotenv").config();

const express = require("express");
const axios = require("axios");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

const ZALO_BOT_TOKEN = process.env.ZALO_BOT_TOKEN;

const ADMIN_IDS = new Set(
  String(process.env.ADMIN_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
);

const MAX_TRANSFER_AMOUNT = Number(
  process.env.MAX_TRANSFER_AMOUNT || 50_000_000
);

const TRANSFER_MODE =
  process.env.TRANSFER_MODE || "manual";

const db = new Database("banking.sqlite");

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY,

    requester_chat_id TEXT NOT NULL,

    bank_code TEXT NOT NULL,
    account_number TEXT NOT NULL,
    account_name TEXT,

    amount INTEGER NOT NULL,
    description TEXT,

    status TEXT NOT NULL DEFAULT 'PENDING',

    approved_by TEXT,
    approved_at TEXT,

    rejected_by TEXT,
    rejected_at TEXT,

    paid_ref TEXT,

    provider_transaction_id TEXT,
    provider_response TEXT,

    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transfer_status
ON transfers(status);
`);


// ========================================
// Utils
// ========================================

function money(number) {
  return Number(number || 0)
    .toLocaleString("vi-VN") + "đ";
}

function makeTransferId() {
  return (
    "TRF-" +
    crypto
      .randomBytes(4)
      .toString("hex")
      .toUpperCase()
  );
}

function isAdmin(chatId) {
  return ADMIN_IDS.has(String(chatId));
}

function hideAccount(account) {
  account = String(account);

  if (account.length <= 4) {
    return account;
  }

  return (
    "*".repeat(account.length - 4) +
    account.slice(-4)
  );
}


// ========================================
// Zalo
// ========================================

async function sendMessage(chatId, text) {

  const url =
    `https://bot-api.zaloplatforms.com/` +
    `bot${ZALO_BOT_TOKEN}/sendMessage`;

  const { data } = await axios.post(
    url,
    {
      chat_id: String(chatId),
      text
    },
    {
      timeout: 10000,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  if (!data?.ok) {
    throw new Error(
      "Zalo error: " +
      JSON.stringify(data)
    );
  }

  return data;
}


// ========================================
// DB
// ========================================

function getTransfer(id) {

  return db
    .prepare(`
      SELECT *
      FROM transfers
      WHERE id = ?
    `)
    .get(String(id).toUpperCase());

}


function createTransfer(data) {

  db.prepare(`
    INSERT INTO transfers (
      id,
      requester_chat_id,
      bank_code,
      account_number,
      account_name,
      amount,
      description,
      status,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
  `).run(
    data.id,
    data.requester_chat_id,
    data.bank_code,
    data.account_number,
    data.account_name,
    data.amount,
    data.description,
    new Date().toISOString()
  );

}


// ========================================
// Transfer provider
// ========================================

async function executeApprovedTransfer(tx) {

  /*
   * MODE 1:
   * Chỉ duyệt tay.
   *
   * Admin tự chuyển trong app ngân hàng,
   * sau đó dùng:
   *
   * /paid TRF-XXXX ma_giao_dich
   */

  if (TRANSFER_MODE === "manual") {

    return {
      mode: "manual",
      success: false,
      requiresManualPayment: true
    };

  }


  /*
   * MODE 2:
   * Nếu Pay2S cấp API chi hộ riêng.
   *
   * KHÔNG tự đoán endpoint.
   */

  if (TRANSFER_MODE === "pay2s") {

    const endpoint =
      process.env.PAY2S_TRANSFER_ENDPOINT;

    const token =
      process.env.PAY2S_TRANSFER_TOKEN;

    if (!endpoint || !token) {
      throw new Error(
        "Chưa cấu hình Pay2S Transfer API"
      );
    }

    /*
     * Payload bên dưới là adapter mẫu.
     *
     * Khi bạn gửi tài liệu chi hộ Pay2S,
     * sửa chính xác field tại đây.
     */

    const payload = {
      requestId: tx.id,

      bankCode: tx.bank_code,

      accountNumber:
        tx.account_number,

      accountName:
        tx.account_name,

      amount:
        tx.amount,

      description:
        tx.description
    };

    const response =
      await axios.post(
        endpoint,
        payload,
        {
          timeout: 30000,

          headers: {
            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${token}`
          }
        }
      );

    return {
      mode: "pay2s",
      success: true,
      data: response.data
    };

  }

  throw new Error(
    `TRANSFER_MODE không hợp lệ: ${TRANSFER_MODE}`
  );
}


// ========================================
// /transfer
// ========================================

async function commandTransfer(
  chatId,
  args
) {

  /*
   * Format:
   *
   * /transfer VCB 0123456789 500000 NGUYEN_VAN_A hoan_tien
   */

  if (args.length < 3) {

    await sendMessage(
      chatId,

`❌ Sai cú pháp.

Dùng:

/transfer BANK STK SOTIEN TEN NGHICHU

Ví dụ:

/transfer VCB 0123456789 500000 NGUYEN_VAN_A HOAN_TIEN`
    );

    return;
  }


  const bankCode =
    String(args[0]).toUpperCase();

  const accountNumber =
    String(args[1])
      .replace(/\D/g, "");

  const amount =
    Number(
      String(args[2])
        .replace(/[^\d]/g, "")
    );


  const accountName =
    args[3]
      ? args[3]
          .replaceAll("_", " ")
      : "";


  const description =
    args
      .slice(4)
      .join(" ")
      .replaceAll("_", " ");


  if (
    !accountNumber ||
    accountNumber.length < 6
  ) {

    await sendMessage(
      chatId,
      "❌ Số tài khoản không hợp lệ."
    );

    return;
  }


  if (
    !Number.isInteger(amount) ||
    amount <= 0
  ) {

    await sendMessage(
      chatId,
      "❌ Số tiền không hợp lệ."
    );

    return;
  }


  if (amount > MAX_TRANSFER_AMOUNT) {

    await sendMessage(
      chatId,

      `❌ Vượt hạn mức ${money(
        MAX_TRANSFER_AMOUNT
      )}.`
    );

    return;
  }


  const id =
    makeTransferId();


  createTransfer({
    id,

    requester_chat_id:
      String(chatId),

    bank_code:
      bankCode,

    account_number:
      accountNumber,

    account_name:
      accountName,

    amount,

    description
  });


  await sendMessage(
    chatId,

`🟡 YÊU CẦU CHUYỂN TIỀN

ID: ${id}

🏦 Bank: ${bankCode}
💳 STK: ${hideAccount(accountNumber)}
👤 Tên: ${accountName || "N/A"}
💰 Số tiền: ${money(amount)}
📝 Nội dung: ${description || "N/A"}

Trạng thái: PENDING

⛔ Chưa có tiền được chuyển.
Đang chờ admin duyệt.`
  );


  // báo cho admin

  for (const adminId of ADMIN_IDS) {

    await sendMessage(
      adminId,

`🔔 YÊU CẦU TRANSFER

ID: ${id}

🏦 ${bankCode}
💳 ${accountNumber}
👤 ${accountName || "N/A"}

💰 ${money(amount)}

📝 ${description || "N/A"}

Người tạo:
${chatId}

Duyệt:
/approve ${id}

Từ chối:
/reject ${id}`
    );

  }

}


// ========================================
// /approve
// ========================================

async function commandApprove(
  chatId,
  id
) {

  if (!isAdmin(chatId)) {

    await sendMessage(
      chatId,
      "⛔ Bạn không có quyền duyệt."
    );

    return;
  }


  id =
    String(id || "")
      .toUpperCase();


  if (!id) {

    await sendMessage(
      chatId,
      "Dùng: /approve TRF-XXXX"
    );

    return;
  }


  /*
   * Transaction DB để chống 2 admin
   * approve cùng lúc.
   */

  const approve =
    db.transaction(() => {

      const tx =
        getTransfer(id);

      if (!tx) {

        return {
          error:
            "Không tìm thấy transfer."
        };

      }


      if (tx.status !== "PENDING") {

        return {
          error:
            `Transfer đang ở trạng thái ${tx.status}`
        };

      }


      const result =
        db.prepare(`
          UPDATE transfers

          SET
            status = 'APPROVING',
            approved_by = ?,
            approved_at = ?

          WHERE
            id = ?
            AND status = 'PENDING'
        `)
        .run(
          String(chatId),
          new Date().toISOString(),
          id
        );


      if (
        result.changes !== 1
      ) {

        return {
          error:
            "Transfer vừa được admin khác xử lý."
        };
      }


      return {
        tx:
          getTransfer(id)
      };

    })();


  if (approve.error) {

    await sendMessage(
      chatId,
      `❌ ${approve.error}`
    );

    return;
  }


  const tx =
    approve.tx;


  try {

    const result =
      await executeApprovedTransfer(tx);


    /*
     * MANUAL MODE
     */

    if (
      result.requiresManualPayment
    ) {

      db.prepare(`
        UPDATE transfers

        SET status = 'APPROVED'

        WHERE id = ?
          AND status = 'APPROVING'
      `).run(id);


      await sendMessage(
        chatId,

`✅ ĐÃ DUYỆT

${id}

🏦 ${tx.bank_code}
💳 ${tx.account_number}
👤 ${tx.account_name || "N/A"}

💰 ${money(tx.amount)}

📝 ${tx.description || "N/A"}

Mode: MANUAL

Sau khi chuyển tiền trong app ngân hàng:

/paid ${id} MA_GIAO_DICH`
      );


      await sendMessage(
        tx.requester_chat_id,

`✅ Admin đã duyệt ${id}

💰 ${money(tx.amount)}

Trạng thái:
APPROVED

Đang chờ thực hiện chuyển tiền.`
      );


      return;

    }


    /*
     * API MODE
     */

    db.prepare(`
      UPDATE transfers

      SET
        status = 'SUCCESS',
        provider_response = ?

      WHERE id = ?
        AND status = 'APPROVING'
    `).run(
      JSON.stringify(
        result.data || {}
      ),
      id
    );


    await sendMessage(
      chatId,

`✅ TRANSFER SUCCESS

ID: ${id}

💰 ${money(tx.amount)}
🏦 ${tx.bank_code}
💳 ${hideAccount(tx.account_number)}`
    );


    await sendMessage(
      tx.requester_chat_id,

`✅ Chuyển tiền thành công

ID: ${id}
💰 ${money(tx.amount)}`
    );


  } catch (error) {

    console.error(
      "TRANSFER ERROR",
      error.response?.data ||
      error.message
    );


    db.prepare(`
      UPDATE transfers

      SET
        status = 'FAILED',
        provider_response = ?

      WHERE id = ?
        AND status = 'APPROVING'
    `).run(
      JSON.stringify(
        error.response?.data || {
          error:
            error.message
        }
      ),
      id
    );


    await sendMessage(
      chatId,

`❌ TRANSFER FAILED

ID: ${id}

${error.response?.data?.message ||
error.message}`
    );

  }

}


// ========================================
// /reject
// ========================================

async function commandReject(
  chatId,
  id
) {

  if (!isAdmin(chatId)) {

    await sendMessage(
      chatId,
      "⛔ Không có quyền."
    );

    return;
  }


  id =
    String(id || "")
      .toUpperCase();


  const result =
    db.prepare(`
      UPDATE transfers

      SET
        status = 'REJECTED',
        rejected_by = ?,
        rejected_at = ?

      WHERE
        id = ?
        AND status = 'PENDING'
    `)
    .run(
      String(chatId),
      new Date().toISOString(),
      id
    );


  if (!result.changes) {

    await sendMessage(
      chatId,

      "❌ Không tìm thấy request PENDING."
    );

    return;
  }


  const tx =
    getTransfer(id);


  await sendMessage(
    chatId,

    `🚫 Đã từ chối ${id}`
  );


  await sendMessage(
    tx.requester_chat_id,

`🚫 Yêu cầu ${id}
đã bị admin từ chối.`
  );

}


// ========================================
// /paid
// ========================================

async function commandPaid(
  chatId,
  id,
  reference
) {

  if (!isAdmin(chatId)) {

    await sendMessage(
      chatId,
      "⛔ Không có quyền."
    );

    return;
  }


  id =
    String(id || "")
      .toUpperCase();


  if (!reference) {

    await sendMessage(
      chatId,

      "Dùng: /paid TRF-XXXX MA_GIAO_DICH"
    );

    return;
  }


  const result =
    db.prepare(`
      UPDATE transfers

      SET
        status = 'SUCCESS',
        paid_ref = ?

      WHERE
        id = ?
        AND status = 'APPROVED'
    `)
    .run(
      reference,
      id
    );


  if (!result.changes) {

    await sendMessage(
      chatId,

      "❌ Request không ở trạng thái APPROVED."
    );

    return;
  }


  const tx =
    getTransfer(id);


  await sendMessage(
    chatId,

`✅ Đã đánh dấu thanh toán

${id}

Ref:
${reference}`
  );


  await sendMessage(
    tx.requester_chat_id,

`✅ CHUYỂN TIỀN THÀNH CÔNG

ID: ${id}

💰 ${money(tx.amount)}

Mã GD:
${reference}`
  );

}


// ========================================
// /transferinfo
// ========================================

async function commandTransferInfo(
  chatId,
  id
) {

  const tx =
    getTransfer(
      String(id || "")
        .toUpperCase()
    );


  if (!tx) {

    await sendMessage(
      chatId,
      "❌ Không tìm thấy."
    );

    return;
  }


  await sendMessage(
    chatId,

`📄 TRANSFER

ID:
${tx.id}

Trạng thái:
${tx.status}

🏦 ${tx.bank_code}

💳 ${
  isAdmin(chatId)
    ? tx.account_number
    : hideAccount(
        tx.account_number
      )
}

👤 ${tx.account_name || "N/A"}

💰 ${money(tx.amount)}

📝 ${tx.description || "N/A"}

Tạo lúc:
${tx.created_at}`
  );

}


// ========================================
// Parse Zalo update
// ========================================

function extractMessage(update) {

  /*
   * Tùy version Zalo Bot,
   * message có thể nằm trong
   * các nhánh khác nhau.
   */

  const message =
    update.message ||
    update.result?.message ||
    update.data?.message;


  if (!message) {
    return null;
  }


  const chatId =
    message.chat?.id ||
    message.chat_id ||
    message.from?.id ||
    update.chat_id;


  const text =
    message.text;


  if (!chatId || !text) {
    return null;
  }


  return {
    chatId:
      String(chatId),

    text:
      String(text).trim()
  };

}


// ========================================
// Zalo webhook
// ========================================

app.post(
  "/webhook/zalo",
  async (req, res) => {

    /*
     * Response ngay để tránh webhook retry.
     */

    res.sendStatus(200);


    try {

      const msg =
        extractMessage(req.body);


      if (!msg) {
        return;
      }


      const parts =
        msg.text.split(/\s+/);


      const command =
        parts.shift()
          .toLowerCase()
          .split("@")[0];


      switch (command) {

        case "/transfer":

          await commandTransfer(
            msg.chatId,
            parts
          );

          break;


        case "/approve":

          await commandApprove(
            msg.chatId,
            parts[0]
          );

          break;


        case "/reject":

          await commandReject(
            msg.chatId,
            parts[0]
          );

          break;


        case "/paid":

          await commandPaid(
            msg.chatId,
            parts[0],
            parts.slice(1).join(" ")
          );

          break;


        case "/transferinfo":

          await commandTransferInfo(
            msg.chatId,
            parts[0]
          );

          break;

      }


    } catch (error) {

      console.error(
        "ZALO WEBHOOK ERROR:",
        error
      );

    }

  }
);


// ========================================
// Pay2S webhook banking
// ========================================

app.post(
  "/webhook/pay2s",
  async (req, res) => {

    try {

      const auth =
        req.headers.authorization || "";


      if (
        auth !==
        `Bearer ${process.env.PAY2S_WEBHOOK_TOKEN}`
      ) {

        return res
          .status(401)
          .json({
            success: false
          });

      }


      const transactions =
        Array.isArray(
          req.body.transactions
        )
          ? req.body.transactions
          : [];


      /*
       * Bạn có thể thêm phần
       * gửi thông báo giao dịch
       * banking vào đây.
       */

      console.log(
        "Pay2S transactions:",
        transactions
      );


      return res.json({
        success: true
      });


    } catch (error) {

      console.error(error);

      return res
        .status(500)
        .json({
          success: false
        });

    }

  }
);


app.get(
  "/",
  (req, res) => {

    res.json({
      ok: true,
      service:
        "Zalo Banking Bot"
    });

  }
);


app.listen(
  PORT,
  () => {

    console.log(
      `Bot running port ${PORT}`
    );

  }
);
