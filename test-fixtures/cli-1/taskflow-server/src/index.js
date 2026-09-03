import { attachCrumbtrail, attachCrumbtrailErrors } from "./crumbtrail.js";

const app = express();

// Optional Crumbtrail backend capture (no-op unless CRUMBTRAIL_ENDPOINT is set).
await attachCrumbtrail(app);
await attachCrumbtrailErrors(app);
