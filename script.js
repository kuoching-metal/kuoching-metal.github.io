
"use strict";

/*
 * 國靖金屬｜太陽能發電監控正式版 v4
 *
 * 1. Ragic 每 5 分鐘同步
 * 2. 每小時發電量（正常／缺漏估算）
 * 3. 五台逆變器溫度趨勢
 * 4. 五台逆變器轉換效率趨勢
 * 5. 最新設備紀錄
 *
 * 監控電腦預定開機：05:00～18:00
 * 沒有紀錄的時間不補零
 */

// ==================================================
// 設定
// ==================================================

const CONFIG = {
  ragicUrl:
    "https://ap7.ragic.com/kuochingmetal/help-me-guo-jing/10",

  syncMinutes: 5,
  maxIntervalMinutes: 15,
  staleMinutes: 15,

  computerStartHour: 5,
  computerEndHour: 18,

  ragicLimit: 2000,

  // 過低功率可能造成效率數值不穩定
  minEfficiencyPower: 300
};

const FIELD_IDS = {
  date: 1001383,
  time: 1001384,
  device: 1001385,
  temp: 1001390,
  rawTotal: 1001391,
  total: 1001392,
  dc1: 1001398,
  dc2: 1001401,
  dc3: 1001404,
  power: 1001407
};

const FIELD_NAMES = {
  date: ["紀錄日期（Date）", "紀錄日期"],
  time: ["紀錄時間（Time）", "紀錄時間"],
  device: ["設備編號（EQP_ID）", "設備編號"],
  temp: ["逆變器溫度（Inverter_T）", "逆變器溫度"],
  rawTotal: ["原始累計值（Total_W）", "原始累計值"],
  total: ["累積發電量（kWh）", "累積發電量"],
  dc1: ["直流一功率（DC1_W）", "直流一功率"],
  dc2: ["直流二功率（DC2_W）", "直流二功率"],
  dc3: ["直流三功率（DC3_W）", "直流三功率"],
  power: ["交流輸出功率（AC_W）", "交流輸出功率"]
};

const COLORS = [
  "#2476b9",
  "#e8a12b",
  "#2a9d8f",
  "#9b59b6",
  "#e76f51"
];

const $ = id => document.getElementById(id);

let records = [];
let charts = {};
let syncing = false;
let lastSyncTime = null;
let syncError = "";

// ==================================================
// 基本工具
// ==================================================

function getField(row, key) {
  const names = FIELD_NAMES[key] || [];
  const id = String(FIELD_IDS[key]);

  for (const name of names) {
    if (
      row[name] !== undefined &&
      row[name] !== null
    ) {
      return row[name];
    }
  }

  if (
    row[id] !== undefined &&
    row[id] !== null
  ) {
    return row[id];
  }

  return null;
}

function num(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(
    String(value).replace(/,/g, "").trim()
  );

  return Number.isFinite(n) ? n : null;
}

function dateKey(value) {
  return String(value || "")
    .trim()
    .replace(/\//g, "-");
}

function parseLocalTime(date, time) {
  const parts = dateKey(date)
    .split("-")
    .map(Number);

  const match = String(time || "").match(
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?/
  );

  if (
    parts.length !== 3 ||
    parts.some(n => !Number.isInteger(n)) ||
    !match
  ) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);

  if (
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const d = new Date(
    parts[0],
    parts[1] - 1,
    parts[2],
    hour,
    minute,
    second
  );

  if (
    Number.isNaN(d.getTime()) ||
    d.getFullYear() !== parts[0] ||
    d.getMonth() !== parts[1] - 1 ||
    d.getDate() !== parts[2]
  ) {
    return null;
  }

  return d;
}

function formatNumber(value, digits = 1) {
  if (
    value === null ||
    !Number.isFinite(value)
  ) {
    return "--";
  }

  return value.toLocaleString("zh-TW", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatTime(date) {
  if (!date) return "--";

  return [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join(":");
}

function todayKey() {
  const d = new Date();

  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("-");
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

// ==================================================
// Ragic 資料標準化
// ==================================================

function normalize(row) {
  const date = dateKey(getField(row, "date"));
  const time = String(
    getField(row, "time") ?? ""
  ).trim();

  const device = String(
    getField(row, "device") ?? ""
  ).trim();

  const dc1 = num(getField(row, "dc1"));
  const dc2 = num(getField(row, "dc2"));
  const dc3 = num(getField(row, "dc3"));

  const dcValues = [dc1, dc2, dc3]
    .filter(v => v !== null);

  const dc = dcValues.length
    ? dcValues.reduce((a, b) => a + b, 0)
    : null;

  const total =
    num(getField(row, "total")) ??
    num(getField(row, "rawTotal"));

  return {
    date,
    time,
    device,
    timestamp: parseLocalTime(date, time),

    temp: num(getField(row, "temp")),
    power: num(getField(row, "power")),
    total,

    dc1,
    dc2,
    dc3,
    dc
  };
}

// ==================================================
// 資料分組
// ==================================================

function groupByDevice(rows) {
  const map = new Map();

  for (const row of rows) {
    if (!row.device || !row.timestamp) continue;

    if (!map.has(row.device)) {
      map.set(row.device, []);
    }

    map.get(row.device).push(row);
  }

  for (const values of map.values()) {
    values.sort(
      (a, b) => a.timestamp - b.timestamp
    );
  }

  return map;
}

function latestByDevice(rows) {
  const map = new Map();

  for (const row of rows) {
    if (!row.device || !row.timestamp) continue;

    const old = map.get(row.device);

    if (
      !old ||
      row.timestamp > old.timestamp
    ) {
      map.set(row.device, row);
    }
  }

  return [...map.values()].sort(
    (a, b) => a.device.localeCompare(b.device)
  );
}

// ==================================================
// 發電量統計
// ==================================================

function calculateEnergy(rows) {
  const groups = groupByDevice(rows);

  const measured = Array(24).fill(0);
  const estimated = Array(24).fill(0);
  const measuredMinutes = Array(24).fill(0);

  let totalEnergy = 0;
  let estimatedEnergy = 0;

  let normalCount = 0;
  let gapCount = 0;
  let resetCount = 0;

  const deviceCoverage = new Map();

  function distribute(t0, t1, delta, isEstimated) {
    let cursor = t0;

    while (cursor < t1) {
      const hour = new Date(cursor).getHours();

      const nextHour = new Date(cursor);
      nextHour.setMinutes(0, 0, 0);
      nextHour.setHours(nextHour.getHours() + 1);

      const end = Math.min(
        t1,
        nextHour.getTime()
      );

      if (end <= cursor) break;

      const ratio =
        (end - cursor) / (t1 - t0);

      if (isEstimated) {
        estimated[hour] += delta * ratio;
      } else {
        measured[hour] += delta * ratio;
        measuredMinutes[hour] +=
          (end - cursor) / 60000;
      }

      cursor = end;
    }
  }

  for (const [device, values] of groups) {
    const valid = values.filter(
      r => r.total !== null
    );

    let first = null;
    let last = null;

    for (let i = 1; i < valid.length; i++) {
      const prev = valid[i - 1];
      const curr = valid[i];

      const t0 = prev.timestamp.getTime();
      const t1 = curr.timestamp.getTime();

      const minutes = (t1 - t0) / 60000;
      const delta = curr.total - prev.total;

      if (
        minutes <= 0 ||
        !Number.isFinite(delta)
      ) {
        continue;
      }

      if (delta < 0) {
        resetCount++;
        continue;
      }

      if (first === null) first = t0;
      last = t1;

      totalEnergy += delta;

      const isEstimated =
        minutes > CONFIG.maxIntervalMinutes;

      if (isEstimated) {
        gapCount++;
        estimatedEnergy += delta;
      } else {
        normalCount++;
      }

      distribute(
        t0,
        t1,
        delta,
        isEstimated
      );
    }

    deviceCoverage.set(device, {
      first,
      last
    });
  }

  const deviceCount = groups.size;

  const completeness = measuredMinutes.map(
    minutes => deviceCount
      ? Math.min(
          100,
          minutes / (deviceCount * 60) * 100
        )
      : 0
  );

  return {
    measured,
    estimated,
    completeness,

    totalEnergy,
    estimatedEnergy,

    normalCount,
    gapCount,
    resetCount,
    deviceCoverage
  };
}

// ==================================================
// Chart.js 共用
// ==================================================

function createChart(id, config) {
  const canvas = $(id);

  if (!canvas) {
    console.warn("找不到圖表元素：", id);
    return;
  }

  if (charts[id]) {
    charts[id].destroy();
  }

  charts[id] = new Chart(canvas, config);
}

// ==================================================
// 每小時發電量圖
// ==================================================

function drawEnergyChart(result) {
  const labels = Array.from(
    { length: 24 },
    (_, i) => String(i).padStart(2, "0")
  );

  const measured = result.measured.map(
    (value, i) =>
      value === 0 &&
      result.estimated[i] === 0 &&
      result.completeness[i] === 0
        ? null
        : value
  );

  const estimated = result.estimated.map(
    (value, i) =>
      value === 0 &&
      result.measured[i] === 0 &&
      result.completeness[i] === 0
        ? null
        : value
  );

  createChart("dailyChart", {
    type: "bar",

    data: {
      labels,

      datasets: [
        {
          label: "正常紀錄區間（kWh）",
          data: measured,
          backgroundColor: "#e8a12b",
          stack: "energy",
          borderRadius: 3
        },
        {
          label: "缺漏區間估算（kWh）",
          data: estimated,
          backgroundColor: "#a5adb8",
          stack: "energy",
          borderRadius: 3
        }
      ]
    },

    options: {
      responsive: true,
      maintainAspectRatio: false,

      plugins: {
        legend: {
          position: "bottom"
        },

        tooltip: {
          mode: "index",
          intersect: false,

          callbacks: {
            afterBody: items => {
              if (!items.length) return "";

              const i = items[0].dataIndex;

              return (
                "正常資料涵蓋率：" +
                result.completeness[i].toFixed(1) +
                "%"
              );
            }
          }
        }
      },

      scales: {
        x: {
          stacked: true
        },

        y: {
          stacked: true,
          beginAtZero: true,

          title: {
            display: true,
            text: "發電量（kWh）"
          }
        }
      }
    }
  });
}

// ==================================================
// 溫度／效率趨勢
//
// 使用 category 軸，不需要日期套件。
// 所有設備共用同一組時間標籤。
// ==================================================

function calculateEfficiency(row) {
  if (
    row.power === null ||
    row.dc === null ||
    row.dc <= 0 ||
    row.power < CONFIG.minEfficiencyPower
  ) {
    return null;
  }

  const efficiency =
    row.power / row.dc * 100;

  if (
    !Number.isFinite(efficiency) ||
    efficiency < 0 ||
    efficiency > 110
  ) {
    return null;
  }

  return efficiency;
}

function drawTrendChart(id, rows, type) {
  const groups = groupByDevice(rows);

  // 全部實際紀錄時間，作為共同 X 軸
  const timestamps = [
    ...new Set(
      rows
        .filter(r => r.timestamp)
        .map(r => r.timestamp.getTime())
    )
  ].sort((a, b) => a - b);

  const labels = timestamps.map(
    t => formatTime(new Date(t)).slice(0, 5)
  );

  const timeIndex = new Map(
    timestamps.map((t, i) => [t, i])
  );

  const datasets = [];
  let colorIndex = 0;

  for (const [device, values] of groups) {
    const data = Array(
      timestamps.length
    ).fill(null);

    let previous = null;

    for (const row of values) {
      const currentTime =
        row.timestamp.getTime();

      const index = timeIndex.get(currentTime);

      const value = type === "temperature"
        ? row.temp
        : calculateEfficiency(row);

      if (index !== undefined) {
        data[index] = value;
      }

      previous = row;
    }

    const color =
      COLORS[colorIndex % COLORS.length];

    datasets.push({
      label: device,
      data,

      borderColor: color,
      backgroundColor: color,

      borderWidth: 2,
      pointRadius: 2,
      pointHoverRadius: 5,

      tension: 0.15,
      spanGaps: false
    });

    colorIndex++;
  }

  const isTemperature =
    type === "temperature";

  console.log(
    `[Chart] ${id}`,
    {
      records: rows.length,
      devices: datasets.length,
      points: timestamps.length,
      validValues: datasets.reduce(
        (sum, d) =>
          sum + d.data.filter(
            v => v !== null
          ).length,
        0
      )
    }
  );

  createChart(id, {
    type: "line",

    data: {
      labels,
      datasets
    },

    options: {
      responsive: true,
      maintainAspectRatio: false,

      interaction: {
        mode: "nearest",
        intersect: false
      },

      plugins: {
        legend: {
          display: true,
          position: "bottom"
        },

        tooltip: {
          callbacks: {
            label: item => {
              return (
                item.dataset.label +
                "：" +
                formatNumber(item.parsed.y, 1) +
                (isTemperature ? " °C" : " %")
              );
            }
          }
        }
      },

      scales: {
        x: {
          type: "category",

          ticks: {
            autoSkip: true,
            maxTicksLimit: 9,
            maxRotation: 0
          },

          title: {
            display: true,
            text: "紀錄時間"
          }
        },

        y: {
          beginAtZero: false,

          title: {
            display: true,
            text: isTemperature
              ? "溫度（°C）"
              : "轉換效率（%）"
          }
        }
      }
    }
  });
}

// ==================================================
// 設備最新紀錄
// ==================================================

function renderDeviceTable(latest) {
  const table = $("deviceTable");

  if (!table) return;

  table.innerHTML = latest.map(row => {
    const efficiency =
      calculateEfficiency(row);

    return `
      <tr>
        <td>${escapeHTML(row.device)}</td>
        <td>${escapeHTML(row.time)}</td>

        <td>${
          row.power === null
            ? "--"
            : formatNumber(row.power, 0)
        }</td>

        <td>${
          row.temp === null
            ? "--"
            : formatNumber(row.temp, 1)
        }</td>

        <td>${
          efficiency === null
            ? "--"
            : formatNumber(efficiency, 1)
        }</td>
      </tr>
    `;
  }).join("");
}

// ==================================================
// 更新畫面
// ==================================================

function render() {
  const dateFilter = $("dateFilter");

  if (!dateFilter) return;

  const selectedDate = dateFilter.value;

  const rows = records.filter(
    r => r.date === selectedDate
  );

  const latest = latestByDevice(rows);
  const energy = calculateEnergy(rows);

  // 最新交流功率
  const powerRows = latest.filter(
    r => r.power !== null
  );

  const power = powerRows.reduce(
    (sum, r) => sum + r.power,
    0
  );

  setText(
    "power",
    latest.length &&
    powerRows.length === latest.length
      ? formatNumber(power / 1000, 2)
      : "--"
  );

  // 累積發電量
  const totalRows = latest.filter(
    r => r.total !== null
  );

  const total = totalRows.reduce(
    (sum, r) => sum + r.total,
    0
  );

  setText(
    "total",
    latest.length &&
    totalRows.length === latest.length
      ? formatNumber(total, 1)
      : "--"
  );

  // 已記錄區間發電量
  const allCovered =
    latest.length > 0 &&
    latest.every(r => {
      const coverage =
        energy.deviceCoverage.get(r.device);

      return (
        coverage &&
        coverage.first !== null &&
        coverage.last !== null
      );
    });

  setText(
    "daily",
    allCovered
      ? formatNumber(energy.totalEnergy, 2)
      : "--"
  );

  // 最新整體轉換效率
  const efficiencyRows = latest.filter(
    r => calculateEfficiency(r) !== null
  );

  const acSum = efficiencyRows.reduce(
    (sum, r) => sum + r.power,
    0
  );

  const dcSum = efficiencyRows.reduce(
    (sum, r) => sum + r.dc,
    0
  );

  setText(
    "efficiency",
    latest.length &&
    efficiencyRows.length === latest.length &&
    dcSum > 0
      ? formatNumber(acSum / dcSum * 100, 1)
      : "--"
  );

  // 三張圖表
  drawEnergyChart(energy);

  drawTrendChart(
    "deviceChart",
    rows,
    "temperature"
  );

  drawTrendChart(
    "dcChart",
    rows,
    "efficiency"
  );

  renderDeviceTable(latest);

  // 狀態列
  const times = rows
    .map(r => r.timestamp)
    .filter(Boolean)
    .sort((a, b) => a - b);

  const first = times[0] || null;
  const last = times.length
    ? times[times.length - 1]
    : null;

  let status =
    `${selectedDate}` +
    `｜${rows.length} 筆紀錄` +
    `｜${latest.length} 台設備`;

  if (first && last) {
    status +=
      `｜資料區間 ` +
      `${formatTime(first)}～${formatTime(last)}`;
  }

  status +=
    `｜正常區間 ${energy.normalCount} 筆` +
    `｜估算區間 ${energy.gapCount} 筆`;

  if (energy.gapCount) {
    status +=
      `｜估算電量 ` +
      `${formatNumber(energy.estimatedEnergy, 2)} kWh`;
  }

  if (energy.resetCount) {
    status +=
      `｜⚠ 計數器異常 ${energy.resetCount} 筆`;
  }

  const now = new Date();

  const currentHour =
    now.getHours() +
    now.getMinutes() / 60;

  const withinComputerHours =
    currentHour >= CONFIG.computerStartHour &&
    currentHour < CONFIG.computerEndHour;

  if (
    selectedDate === todayKey() &&
    last &&
    withinComputerHours
  ) {
    const ageMinutes =
      (now.getTime() - last.getTime()) /
      60000;

    if (ageMinutes > CONFIG.staleMinutes) {
      status +=
        `｜⚠ 資料逾時 ` +
        `${Math.floor(ageMinutes)} 分鐘`;
    }
  }

  if (lastSyncTime) {
    status +=
      `｜Ragic 同步 ${formatTime(lastSyncTime)}`;
  }

  if (syncError) {
    status += `｜⚠ ${syncError}`;
  }

  setText("status", status);
}

// ==================================================
// Ragic API
// ==================================================

function extractRagicRecords(json) {
  if (Array.isArray(json)) {
    return json;
  }

  if (
    json &&
    typeof json === "object"
  ) {
    return Object.values(json).filter(
      value =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
  }

  throw new Error("Ragic JSON 格式錯誤");
}

function setRecords(data) {
  const dateFilter = $("dateFilter");
  const previousDate = dateFilter.value;

  const valid = data.filter(
    r =>
      r.date &&
      r.device &&
      r.timestamp
  );

  if (!valid.length) {
    throw new Error("沒有有效的發電紀錄");
  }

  const unique = new Map();

  for (const row of valid) {
    const key =
      `${row.device}|` +
      `${row.timestamp.getTime()}`;

    unique.set(key, row);
  }

  records = [...unique.values()];

  const dates = [
    ...new Set(records.map(r => r.date))
  ].sort();

  dateFilter.value =
    dates.includes(previousDate)
      ? previousDate
      : dates[dates.length - 1];

  render();
}

async function syncRagic() {
  if (syncing) return;

  syncing = true;

  try {
    const url = new URL(
      CONFIG.ragicUrl
    );

    url.searchParams.set("api", "");
    url.searchParams.set(
      "limit",
      String(CONFIG.ragicLimit)
    );

    url.searchParams.set(
      "reverse",
      "true"
    );

    url.searchParams.set(
      "subtables",
      "0"
    );

    url.searchParams.set(
      "_t",
      String(Date.now())
    );

    const response = await fetch(
      url.toString(),
      {
        method: "GET",
        credentials: "omit",
        cache: "no-store"
      }
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const json = await response.json();

    const rows =
      extractRagicRecords(json);

    const normalized =
      rows.map(normalize);

    lastSyncTime = new Date();
    syncError = "";

    setRecords(normalized);

    console.log(
      "[Ragic] 同步成功",
      rows.length,
      "筆"
    );

    // 顯示五台設備實際解析結果
    const latest = latestByDevice(
      records.filter(
        r => r.date === $("dateFilter").value
      )
    );

    console.table(
      latest.map(r => ({
        設備: r.device,
        時間: r.time,
        溫度: r.temp,
        交流功率: r.power,
        直流功率: r.dc,
        轉換效率: calculateEfficiency(r)
      }))
    );

  } catch (error) {
    console.error(
      "[Ragic] 同步失敗",
      error
    );

    syncError =
      `同步失敗：${error.message}`;

    render();

  } finally {
    syncing = false;
  }
}

// ==================================================
// 啟動
// ==================================================

function startDashboard() {
  const dateFilter = $("dateFilter");

  if (!dateFilter) {
    console.error(
      "找不到 dateFilter 元素"
    );
    return;
  }

  if (typeof Chart === "undefined") {
    console.error(
      "Chart.js 尚未載入"
    );

    setText(
      "status",
      "錯誤：Chart.js 尚未載入"
    );

    return;
  }

  dateFilter.addEventListener(
    "change",
    render
  );

  syncRagic();

  setInterval(
    syncRagic,
    CONFIG.syncMinutes * 60 * 1000
  );

  console.log(
    "[Dashboard] 正式版 v4 啟動"
  );
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    startDashboard
  );
} else {
  startDashboard();
}
