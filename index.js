require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const PIPEDRIVE_DOMAIN = process.env.PIPEDRIVE_DOMAIN;
const PIPEDRIVE_TOKEN = process.env.PIPEDRIVE_TOKEN;

const PD_V1 = `https://${PIPEDRIVE_DOMAIN}.pipedrive.com/v1`;
const PD_V2 = `https://${PIPEDRIVE_DOMAIN}.pipedrive.com/api/v2`;

// ====== Confirmed IDs ======
const PIPELINE_ID = 3;
const STAGE_NEW_SUBMISSION = 11;
const STAGE_FUNDED = 18;

// ====== Deal custom field keys ======
const FIELDS = {
  dealId:        "56cb809cf0009cc189b968c54231dc32529b1ed3",
  amount:        "02d50bd14fd4bbc20a07e72727dc96762a89f7ec",
  factorRate:    "cd0317ac6d05f9d1f370a48c9f741bc0c664e591",
  termDays:      "0585cd0555bdfcd14e9bdeeac660487096fcbbfe",
  payFreq:       "7d9cb77d0d9a2245678c4973d5907b383fa501ea",
  origFee:       "efb0a2350341e08af9e14a3cce1996be6ba933f8",
  isoCommission: "625d0abbd2dc7125fff559117ee1f019ceadbf8e",
  payStatus:     "234193038359da67c9b84d74996ad5de101e658c",
  offerId:       "84eca0981d035197e686b51932f4265aad2ed6ea",
  whiteLabel:    "d3212cebf9320116708ddd2e5ffa8773fd0b206d"
};

// ====== Retry helper ======
async function requestWithRetry(fn, { retries = 3 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const status = err.response?.status;
      const isRateLimit = status === 429;
      const isNetwork = !status && (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND");
      if (attempt > retries || (!isRateLimit && !isNetwork)) throw err;
      const waitMs = 1000 * Math.pow(2, attempt - 1);
      console.log(`[retry] attempt ${attempt}/${retries} waiting ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// ====== Pipedrive helpers ======
async function searchDealByDealId(dealId) {
  const res = await requestWithRetry(() =>
    axios.get(`${PD_V2}/deals/search`, {
      params: {
        api_token: PIPEDRIVE_TOKEN,
        term: dealId,
        fields: "custom_fields",
        exact_match: true
      }
    })
  );
  const items = res.data?.data?.items || [];
  return items.length ? items[0].item : null;
}

async function getDeal(pdDealId) {
  const res = await requestWithRetry(() =>
    axios.get(`${PD_V1}/deals/${pdDealId}`, {
      params: { api_token: PIPEDRIVE_TOKEN }
    })
  );
  return res.data?.data;
}

async function createDeal(body) {
  const res = await requestWithRetry(() =>
    axios.post(`${PD_V1}/deals`, body, {
      params: { api_token: PIPEDRIVE_TOKEN }
    })
  );
  return res.data?.data;
}

async function updateDeal(pdDealId, body) {
  const res = await requestWithRetry(() =>
    axios.put(`${PD_V1}/deals/${pdDealId}`, body, {
      params: { api_token: PIPEDRIVE_TOKEN }
    })
  );
  return res.data?.data;
}

async function moveDealStage(pdDealId, stageId) {
  return updateDeal(pdDealId, { stage_id: stageId });
}

// ====== Routes ======
app.get("/", (req, res) => res.send("LendSaaS Integration Running"));

app.post("/webhook/lendsaas", async (req, res) => {
  const data = req.body || {};

  // Log full incoming payload for debugging
  console.log("[incoming]", JSON.stringify(data));

  try {
    // ====== FIX: Map LendSaaS ## fields (lowercase) ======
    const lendSaasId   = data.dealId || data.DealId;
    const newStatus    = data.new_status || data.newStatus || data.PaymentStatus;
    const entityName   = data.entityName || data.BorrowerName || "New Deal";
    const submissionId = data.submissionId || data.SubmissionId;

    if (!lendSaasId) {
      console.log("[error] Missing dealId in payload:", data);
      return res.status(400).json({ error: "dealId required" });
    }

    // Build deal fields
    const dealFields = {
      title:       `${entityName} - LendSaaS #${lendSaasId}`,
      pipeline_id: PIPELINE_ID,

      // Custom fields
      [FIELDS.dealId]:        String(lendSaasId),
      [FIELDS.payStatus]:     newStatus ? String(newStatus) : undefined,
      [FIELDS.whiteLabel]:    entityName ? String(entityName) : undefined,
    };

    // Remove undefined
    Object.keys(dealFields).forEach((k) => dealFields[k] === undefined && delete dealFields[k]);

    // Search for existing deal by LendSaaS ID
    const found = await searchDealByDealId(String(lendSaasId));

    let pdDealId;
    let action;

    if (!found) {
      // CREATE new deal
      const created = await createDeal({
        ...dealFields,
        stage_id: STAGE_NEW_SUBMISSION
      });
      pdDealId = created.id;
      action = "created";
      console.log(`[created] LendSaasId=${lendSaasId} PipedriveDealId=${pdDealId} Status=${newStatus} Entity=${entityName}`);
    } else {
      // UPDATE existing deal
      pdDealId = found.id;
      await updateDeal(pdDealId, dealFields);
      action = "updated";
      console.log(`[updated] LendSaasId=${lendSaasId} PipedriveDealId=${pdDealId} Status=${newStatus} Entity=${entityName}`);
    }

    // Move to Funded stage if status = Performing
    const statusStr = String(newStatus || "").trim().toLowerCase();
    if (statusStr === "performing") {
      const current = await getDeal(pdDealId);
      if (current?.stage_id !== STAGE_FUNDED) {
        await moveDealStage(pdDealId, STAGE_FUNDED);
        console.log(`[stage] moved LendSaasId=${lendSaasId} -> Funded (${STAGE_FUNDED})`);
      } else {
        console.log(`[stage] already funded LendSaasId=${lendSaasId}`);
      }
    }

    return res.status(200).json({ success: true, action, pipedriveDealId: pdDealId });

  } catch (err) {
    const status = err.response?.status;
    const details = err.response?.data || err.message;
    console.error("[error]", status || "", JSON.stringify(details));

    if (status === 401 || status === 403) {
      return res.status(500).json({ error: "Pipedrive auth failed (check token)", details });
    }
    return res.status(500).json({ error: "Processing failed", details });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
