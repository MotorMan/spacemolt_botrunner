import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const PROFIT_LOG_PATH = join(process.cwd(), "data", "transportProfitDebug.csv");

export function logTransportProfit(
  botUsername: string,
  passengerName: string,
  fare: number,
): void {
  const header = "botName,passenger_name,fare\n";
  const line = `${botUsername},${passengerName},${fare}\n`;
  
  try {
    const dir = dirname(PROFIT_LOG_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(PROFIT_LOG_PATH)) {
      writeFileSync(PROFIT_LOG_PATH, header);
    }
    writeFileSync(PROFIT_LOG_PATH, line, { flag: "a" });
  } catch (err) {
    console.error(`[Transport] Failed to write profit log: ${err}`);
  }
}