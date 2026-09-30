import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceUrl = "https://swoc.rid.go.th/webservice/keystation/getKeyStationGeoJson.ashx";
const rainServiceUrl = "https://swoc.rid.go.th/webservice/weather/RainService.svc/getHIITeleFromIDRange";
const outputPath = path.join(process.cwd(), "water-data.json");
const rainStation = {
  stationId: 709,
  name: "บ้านโป่ง",
  latitude: 13.818629264831543,
  longitude: 99.86508178710938
};
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

function parseRidDate(value) {
  const milliseconds = value?.match(/\/Date\((\d+)/)?.[1];
  return milliseconds ? new Date(Number(milliseconds)) : null;
}

function bangkokDate(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}${fields.month}${fields.day}`;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    console.error(`RID telemetry unavailable after retries; preserving the previous snapshot: ${error.message}`);
    process.exit(0);
  }
  throw error;
}

const checkedAt = new Date();
const stations = payload.features.flatMap((feature) => {
  const properties = feature.properties ?? {};
  if (properties.basinname !== "ลุ่มน้ำแม่กลอง") return [];

  const [longitude, latitude] = feature.geometry?.coordinates ?? [];
  const waterLevel = Number(properties.wl);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  if (!Number.isFinite(waterLevel)) return [];
  const hasDischarge = properties.Q !== null && properties.Q !== undefined && properties.Q !== "";
  const discharge = hasDischarge && Number.isFinite(Number(properties.Q)) ? Number(properties.Q) : null;

  return [{
    stationId: properties.stationid,
    stationCode: properties.stationcode,
    role: properties.ampurname === "บ้านโป่ง" ? "สถานีในอำเภอบ้านโป่ง" : "สถานีเครือข่ายลุ่มน้ำแม่กลอง",
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

let rainfall = {
  station: rainStation,
  status: "unavailable",
  checkedAt: checkedAt.toISOString(),
  measurements: []
};

try {
  const timeEnd = bangkokDate(checkedAt);
  const timeStart = bangkokDate(new Date(checkedAt.getTime() - 10 * 24 * 60 * 60 * 1000));
  const rainResponse = await fetchWithRetry(rainServiceUrl, {
    method: "POST",
    headers: { "content-type": "application/json;charset=utf-8", accept: "application/json" },
    body: JSON.stringify({ rainWeatherModel: { StationID: rainStation.stationId, TimeStart: timeStart, TimeEnd: timeEnd } })
  });
  if (!rainResponse.ok) throw new Error(`RID rainfall returned HTTP ${rainResponse.status}`);
  const rainRows = await rainResponse.json();
  const validRows = Array.isArray(rainRows) ? rainRows.filter((row) => parseRidDate(row.RainfallDatetime)) : [];
  rainfall.status = validRows.length ? "available" : "no-recent-readings";
  rainfall.measurements = validRows.slice(-24).map((row) => {
    const measuredAt = gradeMeasurementTime(row.RainfallDatetime, parseRidDate(row.RainfallDatetime), checkedAt);
    return {
      measuredAt,
        rainfall3HoursMm: optionalNumber(row.Rainfall3H),
        rainfall24HoursMm: optionalNumber(row.Rainfall24H)
    };
  });
} catch (error) {
  rainfall.status = "unavailable";
  rainfall.error = error.message;
  console.error(`RID rainfall could not be fetched: ${error.message}`);
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
  rainfall
};

await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${stations.length} RID stations to ${outputPath}`);
for (const station of stations) {
  const discharge = station.dischargeCubicMetersPerSecond == null ? "not reported" : `${station.dischargeCubicMetersPerSecond} m3/s`;
  console.log(`${station.stationCode} ${station.name}: wl=${station.waterLevelMeters} m, Q=${discharge}, measured=${station.measuredAt.raw} (${station.measuredAt.quality})`);
}
console.log(`Ban Pong HII rainfall station: ${rainfall.status}, ${rainfall.measurements.length} samples`);