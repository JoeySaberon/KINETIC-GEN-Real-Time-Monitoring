import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getEnergyUnit, getPowerUnit } from "../units";

function SparklineChart({ data, isDark }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data}>
        <Area
          type="monotone"
          dataKey="value"
          stroke={isDark ? "#34d399" : "#10b981"}
          fill={isDark ? "#22c55e33" : "#10b98122"}
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function EnergyChart({ data }) {
  const hourlyData = data.reduce((buckets, entry) => {
    if (!entry.timestampMs) {
      return buckets;
    }

    const hourTimestamp = new Date(entry.timestampMs);
    hourTimestamp.setMinutes(0, 0, 0);
    const bucketKey = hourTimestamp.getTime();
    const existingBucket = buckets.get(bucketKey);

    buckets.set(bucketKey, {
      timestampMs: bucketKey,
      time: hourTimestamp.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      intervalEnergy:
        (existingBucket?.intervalEnergy || 0) + (entry.intervalEnergy || 0),
    });

    return buckets;
  }, new Map());

  const currentHour = new Date();
  currentHour.setMinutes(0, 0, 0);
  const chartData = Array.from({ length: 24 }, (_, index) => {
    const hourTimestamp = new Date(currentHour);
    hourTimestamp.setHours(currentHour.getHours() - (23 - index));
    const bucket = hourlyData.get(hourTimestamp.getTime());

    return {
      timestampMs: hourTimestamp.getTime(),
      time: hourTimestamp.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      intervalEnergy: bucket?.intervalEnergy || 0,
    };
  });
  const maximumEnergyMwh = Math.max(
    0,
    ...chartData.map((entry) => Math.abs(entry.intervalEnergy)),
  );
  const energyUnit = getEnergyUnit(maximumEnergyMwh);
  const energyScale = energyUnit === "µWh" ? 1000 : 1;
  const energyDigits = energyUnit === "µWh" ? 1 : 4;
  const displayData = chartData.map((entry) => ({
    ...entry,
    intervalEnergy: entry.intervalEnergy * energyScale,
  }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={displayData}>
        <XAxis
          dataKey="time"
          stroke="#64748b"
          tick={{ fontSize: 11 }}
          interval="preserveStartEnd"
          minTickGap={32}
        />
        <YAxis
          stroke="#64748b"
          tick={{ fontSize: 11 }}
          tickFormatter={(value) => Number(value).toFixed(energyDigits)}
          label={{
            value: `Energy (${energyUnit})`,
            angle: -90,
            position: "insideLeft",
            style: { textAnchor: "middle", fill: "#64748b", fontSize: 10 },
          }}
        />
        <CartesianGrid stroke="#1f2937" strokeDasharray="4 4" />
        <Tooltip
          contentStyle={{
            backgroundColor: "#0f172a",
            border: "1px solid #1f2937",
            borderRadius: 12,
          }}
          labelStyle={{ color: "#94a3b8" }}
          formatter={(value) => [
            `${Number(value).toFixed(energyDigits)} ${energyUnit}`,
            "Energy",
          ]}
        />
        <Line
          type="monotone"
          dataKey="intervalEnergy"
          name="Energy"
          stroke="#34d399"
          strokeWidth={3}
          dot={{ r: 3, fill: "#34d399", strokeWidth: 0 }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function TrafficChart({ data, trafficCategory }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data}>
        <XAxis dataKey="hour" stroke="#64748b" tick={{ fontSize: 11 }} />
        <YAxis stroke="#64748b" tick={{ fontSize: 11 }} />
        <Tooltip
          cursor={false}
          contentStyle={{
            backgroundColor: "#0f172a",
            border: "1px solid #1f2937",
            borderRadius: 12,
          }}
          labelStyle={{ color: "#94a3b8" }}
        />
        <Bar
          dataKey="low"
          fill="#34d399"
          hide={trafficCategory !== "all" && trafficCategory !== "low"}
          radius={[6, 6, 0, 0]}
          activeBar={false}
        />
        <Bar
          dataKey="medium"
          fill="#38bdf8"
          hide={trafficCategory !== "all" && trafficCategory !== "medium"}
          radius={[6, 6, 0, 0]}
          activeBar={false}
        />
        <Bar
          dataKey="high"
          fill="#f97316"
          hide={trafficCategory !== "all" && trafficCategory !== "high"}
          radius={[6, 6, 0, 0]}
          activeBar={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

function limitChartPoints(data, maxPoints = 60) {
  if (data.length <= maxPoints) {
    return data;
  }

  const lastIndex = data.length - 1;
  const step = lastIndex / (maxPoints - 1);

  return Array.from({ length: maxPoints }, (_, index) => {
    return data[Math.round(index * step)];
  });
}

function MpptChart({ data }) {
  const maximumPowerMw = Math.max(
    0,
    ...data.map((entry) => Math.abs(Number(entry.power) || 0)),
  );
  const powerUnit = getPowerUnit(maximumPowerMw);
  const powerScale = powerUnit === "µW" ? 1000 : 1;
  const powerDigits = powerUnit === "µW" ? 0 : 3;
  const displayData = limitChartPoints(data).map((entry) => ({
    ...entry,
    power: entry.power * powerScale,
  }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={displayData}>
        <CartesianGrid stroke="#1f2937" strokeDasharray="4 4" />
        <XAxis
          dataKey="time"
          stroke="#64748b"
          tick={{ fontSize: 11 }}
          interval="preserveStartEnd"
          minTickGap={40}
        />
        <YAxis
          yAxisId="power"
          stroke="#f97316"
          tick={{ fontSize: 11 }}
          tickFormatter={(value) => Number(value).toFixed(powerDigits)}
        />
        <YAxis
          yAxisId="vref"
          orientation="right"
          stroke="#38bdf8"
          tick={{ fontSize: 11 }}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#0f172a",
            border: "1px solid #1f2937",
            borderRadius: 12,
          }}
          formatter={(value, name) =>
            name === `Power (${powerUnit})`
              ? [`${Number(value).toFixed(powerDigits)} ${powerUnit}`, name]
              : [value, name]
          }
        />
        <Line
          yAxisId="power"
          type="monotone"
          dataKey="power"
          stroke="#f97316"
          strokeWidth={3}
          dot={false}
          name={`Power (${powerUnit})`}
        />
        <Line
          yAxisId="vref"
          type="stepAfter"
          dataKey="vref"
          stroke="#38bdf8"
          strokeWidth={2}
          dot={false}
          name="Vref (V)"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default function Charts({ type, ...props }) {
  if (type === "sparkline") return <SparklineChart {...props} />;
  if (type === "energy") return <EnergyChart {...props} />;
  if (type === "traffic") return <TrafficChart {...props} />;
  return <MpptChart {...props} />;
}
