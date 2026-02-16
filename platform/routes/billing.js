import express from "express";
import { authSession } from "../middlewares/authSession.js";
import { getOrgBilling, getFleetBilling, recordUsageEvent } from "../handlers/billing.js";
import helper from "../util/helper.js";
import ERROR_CODES from "../config/errorCodes.js";

const router = express.Router({ mergeParams: true });

/*
@route      /v1/billing/fleet
@method     GET
@desc       Returns billing summary for all DOKS clusters
@access     private
*/
router.get("/fleet", authSession, async (req, res) => {
	try {
		const billing = await getFleetBilling();
		res.json(billing);
	} catch (error) {
		helper.handleError(req, res, error);
	}
});

/*
@route      /v1/billing/:orgId
@method     GET
@desc       Returns billing breakdown for a single org's DOKS cluster
@access     private
*/
router.get("/:orgId", authSession, async (req, res) => {
	try {
		const billing = await getOrgBilling(req.params.orgId);
		if (!billing) {
			return res.status(404).json({
				error: "Not Found",
				details: "Organization not found",
				code: ERROR_CODES.notFound,
			});
		}
		res.json(billing);
	} catch (error) {
		helper.handleError(req, res, error);
	}
});

export default router;
