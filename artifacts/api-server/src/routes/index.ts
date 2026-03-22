import { Router, type IRouter } from "express";
import healthRouter from "./health";
import trafficRouter from "./traffic";
import poiRouter from "./poi";
import populationRouter from "./population";
import stopsRouter from "./stops";
import routesBusRouter from "./routes-bus";
import analysisRouter from "./analysis";
import cronRouter from "./cron";
import gtfsRouter from "./gtfs";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(trafficRouter);
router.use(poiRouter);
router.use(populationRouter);
router.use(stopsRouter);
router.use(routesBusRouter);
router.use(analysisRouter);
router.use(cronRouter);
router.use(gtfsRouter);
router.use(adminRouter);

export default router;
