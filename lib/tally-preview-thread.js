import { parentPort, workerData } from "node:worker_threads";
import { publishSourceCompany, writeSourcePreview } from "./tally-routes.js";

try {
  const result=workerData.job==="commit" ? await publishSourceCompany(workerData.dataDir,workerData.token) : await writeSourcePreview(workerData.dataDir,workerData.input);
  parentPort.postMessage({result});
} catch (error) {
  parentPort.postMessage({error:error.message});
}
