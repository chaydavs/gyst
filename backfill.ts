import { initDatabase } from "./src/store/database.js";
import { initVectorStore, backfillVectors } from "./src/store/embeddings.js";
import { loadConfig } from "./src/utils/config.js";

const config = loadConfig();
const db = initDatabase(config.dbPath);

console.log("Initialising vector store...");
initVectorStore(db);

console.log("Backfilling vectors...");
await backfillVectors(db);

console.log("Done.");
db.close();
