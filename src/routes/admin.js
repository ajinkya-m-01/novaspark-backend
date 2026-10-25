import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import dashboardRouter from "./admin/dashboard.js";
import usersRouter from "./admin/users.js";
import kycRouter from "./admin/kyc.js";
import presaleRouter from "./admin/presale.js";
import stakingRouter from "./admin/staking.js";
import withdrawalsRouter from "./admin/withdrawals.js";
import supportRouter from "./admin/support.js";
import contentRouter from "./admin/content.js";
import reportsRouter from "./admin/reports.js";
import auditLogRouter from "./admin/audit-log.js";

const router = Router();
router.use(requireAuth, requireAdmin);

router.use("/dashboard", dashboardRouter);
router.use("/users", usersRouter);
router.use("/kyc", kycRouter);
router.use("/presale", presaleRouter);
router.use("/staking", stakingRouter);
router.use("/withdrawals", withdrawalsRouter);
router.use("/support", supportRouter);
router.use("/content", contentRouter);
router.use("/reports", reportsRouter);
router.use("/audit-log", auditLogRouter);

export default router;
