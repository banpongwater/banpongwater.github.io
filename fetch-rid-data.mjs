import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourceUrl = "https://swoc.rid.go.th/webservice/keystation/getKeyStationGeoJson.ashx";
const targetStations = new Map([
  ["K.55A", "สถานีหลัก บ้านโป่ง"],
  ["K.11A", "สถานีต้นน้ำอ้างอิง"]
]);
const thaiMonths = new Map([
  ["มกราคม", 1], ["กุมภาพันธ์", 2], ["มีนาคม", 3], ["เมษายน", 4],
  ["พฤษภาคม", 5], ["มิถุนายน", 6], ["กรกฎาคม", 7], ["สิงหาคม", 8],
  ["กันยายน", 9], ["ตุลาคม", 10], ["พฤศจิกายน", 11], ["ธันวาคม", 12]
]);

function parseThaiDate(value) {
  const match = value?.match(/(\d{1,2})\s+(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s+(\d{4})\s+เวลา\s+(\d{1,2}):(\d{2})/);
  if (!match) return null;

  const [, day, monthName, buddhistYear, hour, minute] = match;
  const year = Number(buddhistYear) - 543;
  const localTimeAsUtc = Date.UTC(year, thaiMonths.get(monthName) - 1, Number(day), Number(hour), Number(minute));
  return new Date(localTimeAsUtc - 7 * 60 * 60 * 1000);
}

function measurementTime(raw, checkedAt) {
  const parsed = parseThaiDate(raw);
  if (!parsed) return { raw: raw ?? null, iso: null, quality: "unknown", ageMinutes: null };

  const ageMinutes = Math.round((checkedAt.getTime() - parsed.getTime()) / 60000);
  let quality = "current";
  if (ageMinutes < -5) quality = "future";
  else if (ageMinutes > 90) quality = "stale";

  return { raw, iso: parsed.toISOString(), quality, ageMinutes };
}

const response = await fetch(sourceUrl, {
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(20000)
});
if (!response.ok) throw new Error(`RID SWOC returned HTTP ${response.status}`);

const payload = JSON.parse(await response.text());
if (!Array.isArray(payload.features)) throw new Error("RID SWOC response has no feature list");

const checkedAt = new Date();
const stations = payload.features.flatMap((feature) => {
  const properties = feature.properties ?? {};
  const displayRole = targetStations.get(properties.stationcode);
  if (!displayRole) return [];

  const [longitude, latitude] = feature.geometry?.coordinates ?? [];
  const waterLevel = Number(properties.wl);
  const discharge = Number(properties.Q);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  if (!Number.isFinite(waterLevel) || !Number.isFinite(discharge)) return [];

  return [{
    stationId: properties.stationid,
    stationCode: properties.stationcode,
    role: displayRole,
    name: properties.name,
    province: properties.provincename,
    district: properties.ampurname,
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
  stations
};

const outputPath = fileURLToPath(new URL("../water-data.json", import.meta.url));
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${stations.length} RID stations to ${outputPath}`);
for (const station of stations) {
  console.log(`${station.stationCode} ${station.name}: wl=${station.waterLevelMeters} m, Q=${station.dischargeCubicMetersPerSecond} m3/s, measured=${station.measuredAt.raw} (${station.measuredAt.quality})`);
}