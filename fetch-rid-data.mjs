import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceUrl = "https://swoc.rid.go.th/webservice/keystation/getKeyStationGeoJson.ashx";
// ThaiWater (HII national telemetry) adds gauges RID SWOC doesn't publish, e.g. HII's RAJ002 in Ban Pong.
// province_code=70 (Ratchaburi) keeps the response ~60 KB instead of ~1.4 MB for the whole country.
const thaiWaterUrl = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load?province_code=70";
const stationPositions = {
  "K.55A": { name: "สะพานค่ายหลวง", latitude: 13.818668365478516, longitude: 99.86474609375 }
};
const outputPath = path.join(process.cwd(), "water-data.json");
const targetDistrict = "บ้านโป่ง";
const requiredStationCode = "K.55A";
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
  },
  {
    id: "wat-ban-pong",
    name: "สะพานวัดบ้านโป่ง",
    latitude: 13.80579,
    longitude: 99.87157,
    road: "สะพานข้ามแม่น้ำแม่กลอง ใกล้วัดบ้านโป่ง (ถนนหลังสถานี)",
    river: "แม่น้ำแม่กลอง",
    stationCode: null,
    // No gauge of its own; the page shows readings from these nearby gauges, labelled as such.
    nearbyStationCodes: ["K.55A", "RAJ002"],
    note: "ThaiWater ระบุพิกัดสถานี K.55A ไว้ที่สะพานนี้ ส่วน RID SWOC ระบุพิกัดห่างไปทางเหนือราว 1.7 กม.",
    coordinateQuality: "OpenStreetMap bridge way 284618017 (145 m span over แม่น้ำแม่กลอง, ~300 m from วัดบ้านโป่ง)",
    source: "OpenStreetMap; ThaiWater",
    sourceUrl: "https://www.openstreetmap.org/way/284618017"
  }
];
const thaiMonths = new Map([
  ["มกราคม", 1], ["กุมภาพันธ์", 2], ["มีนาคม", 3], ["เมษายน", 4],
  ["พฤษภาคม", 5], ["มิถุนายน", 6], ["กรกฎาคม", 7], ["สิงหาคม", 8],
  ["กันยายน", 9], ["ตุลาคม", 10], ["พฤศจิกายน", 11], ["ธันวาคม", 12]
]);

// Write to a temp file first so a crash mid-write never leaves a truncated JSON for the site.
async function writeSnapshot(document) {
  const tempPath = `${outputPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`);
  await rename(tempPath, outputPath);
}

async function readPreviousSnapshot() {
  try {
    const snapshot = JSON.parse(await readFile(outputPath, "utf8"));
    return Array.isArray(snapshot?.stations) && snapshot.stations.length > 0 ? snapshot : null;
  } catch {
    return null;
  }
}

function describeError(error) {
  const cause = error?.cause?.code || error?.cause?.message;
  return cause ? `${error.message} (${cause})` : error.message;
}

// RID SWOC often takes 15+ seconds, so the timeout is generous and covers reading the body,
// which happens inside the retry loop so a stalled download is retried too.
async function fetchTextWithRetry(url, options = {}, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
      // Retry server-side failures too, not just network errors.
      if (response.status >= 500) throw new Error(`RID SWOC returned HTTP ${response.status}`);
      return { response, text: await response.text() };
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt + 1}/${attempts} failed: ${describeError(error)}`);
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 2000 * (2 ** attempt)));
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
  const parsed = new Date(localTimeAsUtc - 7 * 60 * 60 * 1000);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function gradeMeasurementTime(raw, parsed, checkedAt) {
  if (!parsed) return { raw: raw ?? null, iso: null, quality: "unknown", ageMinutes: null };

  const ageMinutes = Math.round((checkedAt.getTime() - parsed.getTime()) / 60000);
  let quality = "current";
  if (ageMinutes < -5) quality = "future";
  // RID posts hourly and ThaiWater mirrors K.55A ~2 h late, so only readings over 3 h old count as stale.
  else if (ageMinutes > 180) quality = "stale";

  return { raw, iso: parsed.toISOString(), quality, ageMinutes };
}

function measurementTime(raw, checkedAt) {
  return gradeMeasurementTime(raw, parseThaiDate(raw), checkedAt);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toStation(feature, checkedAt) {
  const properties = feature?.properties ?? {};
  if (properties.ampurname !== targetDistrict) return null;

  const [longitude, latitude] = feature.geometry?.coordinates ?? [];
  const waterLevel = finiteOrNull(properties.wl);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  // Reject missing or physically implausible gauge readings (sensor faults show up as huge values).
  if (waterLevel === null || waterLevel < -50 || waterLevel > 500) return null;

  return {
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
    bankLevelMeters: finiteOrNull(properties.braelevel),
    dischargeCubicMetersPerSecond: finiteOrNull(properties.Q),
    dischargeCapacityPercent: finiteOrNull(properties.capacitypercent),
    ridStatusCode: properties.wlStatus ?? null,
    ridTrend: properties.wltrend ?? null,
    measuredAt: measurementTime(properties.hourlydate, checkedAt)
  };
}

// ThaiWater timestamps look like "2026-10-03 00:20" in Bangkok time with no zone marker.
function parseThaiWaterDate(value) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute) - 7 * 60 * 60 * 1000);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toThaiWaterStation(row, checkedAt) {
  const station = row.station ?? {};
  const code = station.tele_station_oldcode;
  if (!code || row.geocode?.amphoe_name?.th !== targetDistrict) return null;
  const latitude = finiteOrNull(station.tele_station_lat);
  const longitude = finiteOrNull(station.tele_station_long);
  const waterLevel = finiteOrNull(row.waterlevel_msl);
  if (latitude === null || longitude === null || waterLevel === null || waterLevel < -50 || waterLevel > 500) return null;
  const bank = finiteOrNull(station.min_bank);
  const raw = row.waterlevel_datetime ?? null;
  const measuredAt = gradeMeasurementTime(raw, parseThaiWaterDate(raw), checkedAt);
  if (raw) measuredAt.raw = `${raw} น.`;

  return {
    stationId: station.id,
    thaiWaterId: station.id,
    stationCode: code,
    role: "สถานีในอำเภอบ้านโป่ง",
    name: station.tele_station_name?.th ?? code,
    province: row.geocode?.province_name?.th ?? null,
    district: targetDistrict,
    basin: row.basin?.basin_name?.th ?? null,
    river: row.river_name ?? null,
    latitude,
    longitude,
    waterLevelMeters: waterLevel,
    previousWaterLevelMeters: finiteOrNull(row.waterlevel_msl_previous),
    bankLevelMeters: bank,
    dischargeCubicMetersPerSecond: finiteOrNull(row.discharge),
    dischargeCapacityPercent: finiteOrNull(row.storage_percent),
    ridStatusCode: null,
    ridTrend: bank === null ? null : waterLevel >= bank ? `สูงกว่าตลิ่ง ${(waterLevel - bank).toFixed(2)} ม.` : `ต่ำกว่าตลิ่ง ${(bank - waterLevel).toFixed(2)} ม.`,
    agency: row.agency?.agency_name?.th?.trim() ?? null,
    dataSource: "ThaiWater",
    measuredAt
  };
}

async function collectRid(checkedAt) {
  const { response, text } = await fetchTextWithRetry(sourceUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`RID SWOC returned HTTP ${response.status}`);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("RID SWOC response is not valid JSON");
  }
  if (!Array.isArray(payload?.features)) throw new Error("RID SWOC response has no feature list");
  const stations = payload.features.map((feature) => toStation(feature, checkedAt)).filter(Boolean)
    .map((station) => ({ ...station, agency: "กรมชลประทาน", dataSource: "RID SWOC" }));
  if (!stations.some((station) => station.stationCode === requiredStationCode)) {
    throw new Error(`RID SWOC did not return required Ban Pong station ${requiredStationCode}`);
  }
  return { stations, responseDate: response.headers.get("date") };
}

async function collectThaiWater(checkedAt) {
  const { response, text } = await fetchTextWithRetry(thaiWaterUrl, { headers: { accept: "application/json" } }, 3);
  if (!response.ok) throw new Error(`ThaiWater returned HTTP ${response.status}`);
  const rows = JSON.parse(text)?.waterlevel_data?.data;
  if (!Array.isArray(rows)) throw new Error("ThaiWater response has no water-level list");
  return rows.map((row) => toThaiWaterStation(row, checkedAt)).filter(Boolean);
}

// RID SWOC is the primary source, but it refuses connections from overseas servers such as
// GitHub Actions runners. ThaiWater mirrors K.55A, so either source alone can keep the site current.
async function collect() {
  const checkedAt = new Date();
  const [rid, thaiWater] = await Promise.allSettled([collectRid(checkedAt), collectThaiWater(checkedAt)]);
  const sourceErrors = [];
  if (rid.status === "rejected") sourceErrors.push(`RID SWOC: ${describeError(rid.reason)}`);
  if (thaiWater.status === "rejected") sourceErrors.push(`ThaiWater: ${describeError(thaiWater.reason)}`);

  const stations = rid.status === "fulfilled" ? rid.value.stations : [];
  const thaiWaterStations = thaiWater.status === "fulfilled" ? thaiWater.value : [];
  for (const candidate of thaiWaterStations) {
    const existing = stations.find((station) => station.stationCode === candidate.stationCode);
    if (!existing) {
      // Keep K.55A on its RID coordinates whichever source supplied the reading, so the map doesn't jump.
      const pinned = stationPositions[candidate.stationCode];
      stations.push(pinned ? { ...candidate, ...pinned } : candidate);
    } else {
      existing.thaiWaterId = candidate.thaiWaterId;
    }
  }

  if (!stations.some((station) => station.stationCode === requiredStationCode)) {
    throw new Error(`No source returned required Ban Pong station ${requiredStationCode} (${sourceErrors.join("; ") || "station missing"})`);
  }
  for (const message of sourceErrors) console.error(`Source unavailable, continuing with the others: ${message}`);

  return {
    schemaVersion: 2,
    checkedAt: checkedAt.toISOString(),
    source: {
      name: "Royal Irrigation Department SWOC key-station telemetry",
      url: sourceUrl,
      responseDate: rid.status === "fulfilled" ? rid.value.responseDate : null,
      schedule: "Every 10 minutes (GitHub Actions scheduled workflow; best effort)"
    },
    secondarySources: [{ name: "ThaiWater (HII national water telemetry)", url: thaiWaterUrl }],
    ...(sourceErrors.length ? { sourceErrors } : {}),
    stations,
    bridges: bridgeReferences
  };
}

let document;
try {
  document = await collect();
} catch (error) {
  // Any failure (network, bad payload, missing gauge) keeps the last good snapshot online
  // and records why, instead of publishing nothing or a broken file.
  const previousSnapshot = await readPreviousSnapshot();
  if (!previousSnapshot) {
    console.error(`All water sources unavailable and no previous snapshot exists: ${describeError(error)}`);
    process.exit(1);
  }
  previousSnapshot.stations = previousSnapshot.stations.filter((station) => station.district === targetDistrict);
  previousSnapshot.bridges = bridgeReferences;
  previousSnapshot.collectionError = describeError(error);
  await writeSnapshot(previousSnapshot);
  console.error(`All water sources unavailable after retries; preserving the previous Ban Pong snapshot from ${previousSnapshot.checkedAt}: ${describeError(error)}`);
  process.exit(0);
}

await writeSnapshot(document);
console.log(`Wrote ${document.stations.length} Ban Pong stations and ${bridgeReferences.length} bridge references to ${outputPath}`);
for (const station of document.stations) {
  const discharge = station.dischargeCubicMetersPerSecond == null ? "not reported" : `${station.dischargeCubicMetersPerSecond} m3/s`;
  console.log(`${station.stationCode} ${station.name}: wl=${station.waterLevelMeters} m, Q=${discharge}, measured=${station.measuredAt.raw} (${station.measuredAt.quality})`);
}
