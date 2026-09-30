import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceUrl = "https://swoc.rid.go.th/webservice/keystation/getKeyStationGeoJson.ashx";
const outputPath = path.join(process.cwd(), "water-data.json");
const bridgeReferences = [
  {
    id: "khai-luang",
    name: "สะพานค่ายหลวง",
    latitude: 13.818668365478516,
    longitude: 99.86474609375,
    road: "สะพานข้ามแม่น้ำแม่กลอง",
    river: "แม่น้ำแม่กลอง",
    stationCode: "K.55A",
    coordinateQuality: "RID gauge location",
    source: "กรมชลประทาน SWOC",
    sourceUrl
  },
  {
    id: "khao-ngu-bek-phrai",
    name: "สะพานเขางู–เบิกไพร",
    latitude: 13.8297269,
    longitude: 99.8656443,
    road: "ทางหลวงหมายเลข 3291",
    river: "แม่น้ำแม่กลอง",
    stationCode: null,
    coordinateQuality: "OpenStreetMap bridge feature; approximate center",
    source: "เทศบาลเมืองบ้านโป่ง; OpenStreetMap",
    sourceUrl: "https://banpong.go.th/public/list/data/detail/id/6323/menu/1559"
  },
  {
    id: "ban-muang-rb4005",
    name: "สะพาน รบ.002 บ้านม่วง",
    latitude: 13.75463,
    longitude: 99.8406,
    road: "ถนนสะพานชนบท รบ.4005",
    river: "แม่น้ำแม่กลอง",
    stationCode: null,
    coordinateQuality: "Published map coordinate",
    source: "แขวงทางหลวงชนบทราชบุรี; Yellow Pages bridge listing",
    sourceUrl: "https://www.yellowpages.co.th/"
  }
];
const thaiMonths = new Map([
  ["มกราคม", 1], ["กุมภาพันธ์", 2], ["มีนาคม", 3], ["เมษายน", 4],
  ["พฤษภาคม", 5], ["มิถุนายน", 6], ["กรกฎาคม", 7], ["สิงหาคม", 8],
  ["กันยายน", 9], ["ตุลาคม", 10], ["พฤศจิกายน", 11], ["ธันวาคม", 12]
]);

let previousSnapshot = null;
try {
  previousSnapshot = JSON.parse(await readFile(outputPath, "utf8"));
} catch {
  previousSnapshot = null;
}

async function fetchWithRetry(url, options = {}, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(25000) });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1500 * (2 ** attempt)));
    }
  }
  throw lastError;
}

function parseThaiDate(value) {
  const match = value?.match(/(\d{1,2})\s+(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s+(\d{4})\s+เวลา\s+(\d{1,2}):(\d{2})/);
  if (!match) return null;

  const [, day, monthName, buddhistYear, hour, minute] = match;
  const year = Number(buddhistYear) - 543;
  const localTimeAsUtc = Date.UTC(year, thaiMonths.get(monthName) - 1, Number(day), Number(hour), Number(minute));
  return new Date(localTimeAsUtc - 7 * 60 * 60 * 1000);
}

function gradeMeasurementTime(raw, parsed, checkedAt) {
  if (!parsed) return { raw: raw ?? null, iso: null, quality: "unknown", ageMinutes: null };

  const ageMinutes = Math.round((checkedAt.getTime() - parsed.getTime()) / 60000);
  let quality = "current";
  if (ageMinutes < -5) quality = "future";
  else if (ageMinutes > 90) quality = "stale";

  return { raw, iso: parsed.toISOString(), quality, ageMinutes };
}

function measurementTime(raw, checkedAt) {
  return gradeMeasurementTime(raw, parseThaiDate(raw), checkedAt);
}

let response;
let payload;
try {
  response = await fetchWithRetry(sourceUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`RID SWOC returned HTTP ${response.status}`);
  payload = JSON.parse(await response.text());
  if (!Array.isArray(payload.features)) throw new Error("RID SWOC response has no feature list");
} catch (error) {
  if (Array.isArray(previousSnapshot?.stations) && previousSnapshot.stations.length > 0) {
    previousSnapshot.stations = previousSnapshot.stations.filter((station) => station.district === "บ้านโป่ง");
    previousSnapshot.bridges = bridgeReferences;
    previousSnapshot.collectionError = error.message;
    await writeFile(outputPath, `${JSON.stringify(previousSnapshot, null, 2)}\n`);
    console.error(`RID telemetry unavailable after retries; preserving only the previous Ban Pong snapshot: ${error.message}`);
    process.exit(0);
  }
  throw error;
}

const checkedAt = new Date();
const stations = payload.features.flatMap((feature) => {
  const properties = feature.properties ?? {};
  if (properties.ampurname !== "บ้านโป่ง") return [];

  const [longitude, latitude] = feature.geometry?.coordinates ?? [];
  const waterLevel = Number(properties.wl);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  if (!Number.isFinite(waterLevel)) return [];
  const hasDischarge = properties.Q !== null && properties.Q !== undefined && properties.Q !== "";
  const discharge = hasDischarge && Number.isFinite(Number(properties.Q)) ? Number(properties.Q) : null;

  return [{
    stationId: properties.stationid,
    stationCode: properties.stationcode,
    role: "สถานีในอำเภอบ้านโป่ง",
    name: properties.name,
    province: properties.provincename,
    district: properties.ampurname,
    basin: properties.basinname,
    river: properties.river,
    latitude,
    longitude,
    waterLevelMeters: waterLevel,
    bankLevelMeters: Number.isFinite(Number(properties.braelevel)) ? Number(properties.braelevel) : null,
    dischargeCubicMetersPerSecond: discharge,
    dischargeCapacityPercent: Number.isFinite(Number(properties.capacitypercent)) ? Number(properties.capacitypercent) : null,
    ridStatusCode: properties.wlStatus ?? null,
    ridTrend: properties.wltrend ?? null,
    measuredAt: measurementTime(properties.hourlydate, checkedAt)
  }];
});

if (!stations.some((station) => station.stationCode === "K.55A")) {
  throw new Error("RID SWOC did not return required Ban Pong station K.55A");
}

const document = {
  schemaVersion: 1,
  checkedAt: checkedAt.toISOString(),
  source: {
    name: "Royal Irrigation Department SWOC key-station telemetry",
    url: sourceUrl,
    responseDate: response.headers.get("date"),
    schedule: "Every 10 minutes (GitHub Actions scheduled workflow; best effort)"
  },
  stations,
  bridges: bridgeReferences
};

await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${stations.length} Ban Pong RID stations and ${bridgeReferences.length} bridge references to ${outputPath}`);
for (const station of stations) {
  const discharge = station.dischargeCubicMetersPerSecond == null ? "not reported" : `${station.dischargeCubicMetersPerSecond} m3/s`;
  console.log(`${station.stationCode} ${station.name}: wl=${station.waterLevelMeters} m, Q=${discharge}, measured=${station.measuredAt.raw} (${station.measuredAt.quality})`);
}