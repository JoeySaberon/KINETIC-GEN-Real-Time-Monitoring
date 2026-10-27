export const getPowerUnit = (powerMw) =>
    Math.abs(Number(powerMw) || 0) < 1 ? "µW" : "mW";

export const formatPower = (powerMw) => {
    if (powerMw === null || powerMw === undefined || powerMw === "") {
        return "-";
    }

    const value = Number(powerMw);
    if (!Number.isFinite(value)) {
        return "-";
    }

    if (getPowerUnit(value) === "µW") {
        return `${(value * 1000).toFixed(0)} µW`;
    }

    return `${value.toFixed(3)} mW`;
};

export const getEnergyUnit = (energyMwh) =>
    Math.abs(Number(energyMwh) || 0) < 1 ? "µWh" : "mWh";

export const formatEnergy = (energyMwh) => {
    if (energyMwh === null || energyMwh === undefined || energyMwh === "") {
        return "-";
    }

    const value = Number(energyMwh);
    if (!Number.isFinite(value)) {
        return "-";
    }

    if (getEnergyUnit(value) === "µWh") {
        return `${(value * 1000).toFixed(1)} µWh`;
    }

    return `${value.toFixed(4)} mWh`;
};