import { createCrumbtrailExpressMiddleware } from "crumbtrail-node";

const ENDPOINT = process.env.CRUMBTRAIL_ENDPOINT;
const API_KEY = process.env.CRUMBTRAIL_API_KEY;

app.use(
  createCrumbtrailExpressMiddleware({ endpoint: ENDPOINT, authToken: API_KEY }),
);
