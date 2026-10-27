import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  limitToLast,
  onValue,
  orderByKey,
  query,
  ref,
} from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";
import { createPortal } from "react-dom";
import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  clearFirebaseHistory,
  clearFirebaseTelemetry,
  cleanupFirebaseTelemetry,
  createFirebaseUser,
  firebaseAuth,
  firebaseConfigError,
  firebaseDb,
  firebaseReady,
  authPersistenceReady,
  refreshFirebaseUser,
  sendFirebasePasswordReset,
  signInFirebaseUser,
  signOutFirebaseUser,
  updateFirebaseTileMetadata,
} from "./firebase";
import {
  Activity,
  ArrowLeftRight,
  ArrowUpRight,
  BatteryCharging,
  ArrowLeft,
  Eye,
  EyeOff,
  Footprints,
  Moon,
  Sun,
  Zap,
  BarChart3,
  Clock,
  CircleHelp,
  Download,
  Lightbulb,
  Gauge,
  Trash2,
  Wifi,
  UserCircle,
} from "lucide-react";
import { formatEnergy, formatPower } from "./units";

const Charts = lazy(() => import("./components/Charts"));
const isAndroidApp = Capacitor.getPlatform() === "android";
const TabHaptics = registerPlugin("TabHaptics");

const initialEnergy = 0;
const initialSteps = 0;

const makeEnergySeries = () => [];
const makeTrafficSeries = () => [];
const LDR_NIGHT_THRESHOLD = 1800;
const DEVICE_OFFLINE_TIMEOUT_MS = 15_000;
const CURRENT_STEP_RESET_TIMEOUT_MS = 15_000;
const TRAFFIC_LOW_MAX = 49;
const TRAFFIC_MEDIUM_MAX = 69;
const INITIAL_DEVICE_LOAD_TIMEOUT_MS = 10_000;
const MAX_ENERGY_SAMPLE_GAP_MS = DEVICE_OFFLINE_TIMEOUT_MS;
const ADC_REFERENCE_VOLTAGE = 3.3;
const ADC_MAX_VALUE = 4095;
const MAX_INITIAL_READING_HISTORY = 2_000;
const CLEARED_NODE_KEY = "__dashboardCleared";
const AUTH_INACTIVITY_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_ACTIVITY_STORAGE_KEY = "piezo-dashboard-last-activity";
const ACCOUNT_CREATION_PATH = "/create-account";
const DASHBOARD_SECTION_ORDER = [
  "overview",
  "piezo",
  "mppt",
  "history",
  "guide",
];
const DEFAULT_OVERVIEW_METRIC_ORDER = [
  "energy",
  "steps",
  "mode",
  "currentStep",
];
const DEFAULT_OVERVIEW_CHART_ORDER = ["energyTrend", "heatmap"];
const DEFAULT_PIEZO_METRIC_ORDER = ["voltage", "current", "power"];

const scrollAndroidDashboardToTop = () => {
  if (!isAndroidApp || typeof window === "undefined") {
    return;
  }

  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
};

const loadOverviewOrder = (storageKey, defaultOrder) => {
  if (typeof window === "undefined") {
    return defaultOrder;
  }

  try {
    const savedOrder = JSON.parse(window.localStorage.getItem(storageKey));
    return Array.isArray(savedOrder) &&
      savedOrder.length === defaultOrder.length &&
      defaultOrder.every((item) => savedOrder.includes(item))
      ? savedOrder
      : defaultOrder;
  } catch {
    return defaultOrder;
  }
};

const swapOverviewOrder = (order, draggedId, targetId) => {
  const draggedIndex = order.indexOf(draggedId);
  const targetIndex = order.indexOf(targetId);
  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
    return order;
  }

  const nextOrder = [...order];
  [nextOrder[draggedIndex], nextOrder[targetIndex]] = [
    nextOrder[targetIndex],
    nextOrder[draggedIndex],
  ];
  return nextOrder;
};

const toNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const getGeneratedPower = (entry = {}) => {
  const measuredPower =
    entry.Voltage_V !== undefined && entry.Current_mA !== undefined
      ? toNumber(entry.Voltage_V) * toNumber(entry.Current_mA)
      : toNumber(entry.Power_mW);

  return Math.max(0, measuredPower);
};

const adcToVoltage = (value) =>
  (toNumber(value) / ADC_MAX_VALUE) * ADC_REFERENCE_VOLTAGE;

const getDayNightFromLdr = (value) =>
  toNumber(value) > LDR_NIGHT_THRESHOLD ? "Night" : "Day";

const getSystemModeFromLiveState = (isDark, demandLevel) => {
  if (!isDark) {
    return "Day Standby";
  }

  switch (demandLevel) {
    case "HIGH":
      return "High Demand Lighting";
    case "MEDIUM":
      return "Balanced Lighting";
    case "LOW":
      return "Low Demand Lighting";
    default:
      return "Night Standby";
  }
};

const getTimestampMs = (value) => {
  const timestamp = toNumber(value);
  if (timestamp > 0) {
    return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  }

  if (typeof value === "string") {
    const parsedTimestamp = Date.parse(value);
    return Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0;
  }

  return 0;
};

const formatHistoryTimestamp = (entry) => {
  const timestamp = entry.timestampMs ?? entry.timestamp;
  const timestampMs = getTimestampMs(timestamp);
  return timestampMs > 0
    ? new Date(timestampMs).toLocaleString()
    : timestamp || "—";
};

const getDeviceUpdateValue = (data = {}) =>
  data.lastSeen ??
  data.lastUpdate ??
  data.last_updated ??
  data.lastHeartbeat ??
  data.updatedAt ??
  data.timestamp;

const isRecentDeviceUpdate = (value) => {
  const timestamp = getTimestampMs(value);
  return timestamp > 0 && Date.now() - timestamp <= DEVICE_OFFLINE_TIMEOUT_MS;
};

const makeTileFromFirebase = (data = null, latest = {}) => {
  const voltage =
    data?.Voltage_V !== undefined
      ? toNumber(data.Voltage_V)
      : data?.piezoVoltage !== undefined
        ? toNumber(data.piezoVoltage)
        : adcToVoltage(data?.piezoADC);
  const current = toNumber(data?.Current_mA) / 1000;
  const power = voltage * current * 1000;
  const status = data && typeof data === "object" ? "active" : "offline";

  return {
    tileId:
      typeof data?.tileName === "string" && data.tileName.trim()
        ? data.tileName.trim()
        : "KineticGen",
    zone:
      typeof data?.zone === "string" && data.zone.trim()
        ? data.zone.trim()
        : "KineticGen",
    voltage,
    current,
    power,
    energy: toNumber(latest.energyMWh ?? data?.energy_mWh),
    status,
    timestamp:
      getTimestampMs(latest.lastUpdate ?? data?.lastUpdate) || Date.now(),
  };
};

const makePiezoSummary = (data = null, latest) => {
  const tile = makeTileFromFirebase(data, latest);
  return {
    totalPower: tile.power,
    totalVoltage: tile.voltage,
    totalEnergy: tile.energy,
    activeTiles: tile.status === "active" ? 1 : 0,
    weakTiles: 0,
    offlineTiles: tile.status === "offline" ? 1 : 0,
    tiles: [tile],
  };
};

const makeAlerts = (summary) =>
  summary.tiles
    .filter((tile) => tile.status !== "active")
    .map((tile) => ({
      id: tile.tileId,
      message: `${tile.tileId} is offline or has no current output`,
      severity: "high",
    }));

const mergeAlerts = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
};

function MetricCard({
  title,
  icon: Icon,
  value,
  unit,
  cardClass,
  mutedText,
  subtleText,
  strongText,
  children,
  valueClassName = "",
  contentMarginClassName = "mt-5",
  showIcon = true,
  iconClassName = "text-emerald-400",
  iconBackgroundClassName = "bg-emerald-400/10",
  contentClassName = "",
  className = "",
  dragProps = {},
  dragClassName = "",
}) {
  return (
    <div
      {...dragProps}
      className={`${cardClass} group border-l-2 border-l-emerald-400/70 transition duration-200 hover:-translate-y-0.5 hover:shadow-xl ${className} ${dragClassName}`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className={`text-base font-semibold ${mutedText}`}>{title}</p>
        {showIcon && (
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-xl ${iconBackgroundClassName} ${iconClassName}`}
          >
            <Icon size={18} />
          </span>
        )}
      </div>
      {children || (
        <div className={`${contentMarginClassName} ${contentClassName}`}>
          <p
            className={`text-3xl font-bold tracking-tight sm:text-4xl ${strongText} ${valueClassName}`}
          >
            {value}
          </p>
          <p className={`mt-1 text-xs ${subtleText}`}>{unit}</p>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [clearingData, setClearingData] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [showClearDataPrompt, setShowClearDataPrompt] = useState(false);
  const [showClearHistoryPrompt, setShowClearHistoryPrompt] = useState(false);
  const [clearDataError, setClearDataError] = useState("");
  const [clearHistoryError, setClearHistoryError] = useState("");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [currentPath, setCurrentPath] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname,
  );
  const [newAccountEmail, setNewAccountEmail] = useState("");
  const [newAccountPassword, setNewAccountPassword] = useState("");
  const [newAccountConfirmPassword, setNewAccountConfirmPassword] =
    useState("");
  const [createAccountError, setCreateAccountError] = useState("");
  const [createdAccountEmail, setCreatedAccountEmail] = useState("");
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [notificationMenuPosition, setNotificationMenuPosition] =
    useState(null);
  const [readNotificationIds, setReadNotificationIds] = useState(() => {
    if (typeof window === "undefined") {
      return new Set();
    }

    try {
      const storedIds = JSON.parse(
        window.localStorage.getItem("piezo-dashboard-read-alerts") || "[]",
      );
      return new Set(Array.isArray(storedIds) ? storedIds : []);
    } catch {
      return new Set();
    }
  });
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState(
    () => {
      if (typeof window === "undefined") {
        return new Set();
      }

      try {
        const storedIds = JSON.parse(
          window.localStorage.getItem("piezo-dashboard-dismissed-alerts") ||
            "[]",
        );
        return new Set(Array.isArray(storedIds) ? storedIds : []);
      } catch {
        return new Set();
      }
    },
  );
  const [notificationDismissedIds, setNotificationDismissedIds] = useState(
    () => new Set(),
  );
  const [authError, setAuthError] = useState("");
  const [databaseError, setDatabaseError] = useState("");
  const [authMode, setAuthMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [authNotice, setAuthNotice] = useState("");
  const [verificationPending, setVerificationPending] = useState(false);
  const [dayNightStatus, setDayNightStatus] = useState("Unavailable");
  const [ldrStatus, setLdrStatus] = useState("Unavailable");
  const [themeMode, setThemeMode] = useState(() => {
    if (typeof window === "undefined") {
      return "dark";
    }

    return window.localStorage.getItem("piezo-dashboard-theme") || "dark";
  });
  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigateToPath = (path) => {
    if (typeof window === "undefined" || window.location.pathname === path) {
      setCurrentPath(path);
      return;
    }

    if (currentPath === ACCOUNT_CREATION_PATH && path === "/") {
      window.history.replaceState({}, "", path);
    } else {
      window.history.pushState({}, "", path);
    }
    setCurrentPath(path);
  };
  const [activeSection, setActiveSection] = useState("overview");
  useLayoutEffect(() => {
    setShowProfileMenu(false);
    setShowNotifications(false);
    setActiveSection("overview");

    if (!authUser || !isAndroidApp) {
      return undefined;
    }

    scrollAndroidDashboardToTop();
    const frame = window.requestAnimationFrame(scrollAndroidDashboardToTop);
    return () => window.cancelAnimationFrame(frame);
  }, [authUser]);

  const dashboardTouchStartRef = useRef(null);
  const [overviewMetricOrder, setOverviewMetricOrder] = useState(() =>
    isAndroidApp
      ? loadOverviewOrder(
          "piezo-overview-metric-order",
          DEFAULT_OVERVIEW_METRIC_ORDER,
        )
      : DEFAULT_OVERVIEW_METRIC_ORDER,
  );
  const [overviewChartOrder, setOverviewChartOrder] = useState(() =>
    isAndroidApp
      ? loadOverviewOrder(
          "piezo-overview-chart-order",
          DEFAULT_OVERVIEW_CHART_ORDER,
        )
      : DEFAULT_OVERVIEW_CHART_ORDER,
  );
  const [piezoMetricOrder, setPiezoMetricOrder] = useState(() =>
    isAndroidApp
      ? loadOverviewOrder("piezo-tile-metric-order", DEFAULT_PIEZO_METRIC_ORDER)
      : DEFAULT_PIEZO_METRIC_ORDER,
  );
  const [draggingOverviewItem, setDraggingOverviewItem] = useState(null);
  const [dropTargetOverviewItem, setDropTargetOverviewItem] = useState(null);
  const overviewPointerRef = useRef({
    pointerId: null,
    startX: 0,
    startY: 0,
    timer: null,
    active: null,
    hoveredId: null,
    sourceElement: null,
    ghost: null,
    beforeRects: null,
    frame: null,
    ghostPosition: null,
    latestPointer: null,
  });
  const [systemStatus, setSystemStatus] = useState("Loading");
  const [deviceDataLoading, setDeviceDataLoading] = useState(true);
  const [firebaseConnected, setFirebaseConnected] = useState(false);
  const [lastDeviceUpdate, setLastDeviceUpdate] = useState(0);
  const [currentDateTime, setCurrentDateTime] = useState(() => new Date());
  const [energyTotal, setEnergyTotal] = useState(initialEnergy);
  const [stepsTotal, setStepsTotal] = useState(initialSteps);
  const [currentFootstep, setCurrentFootstep] = useState(0);
  const [stepsLastFiveMinutes, setStepsLastFiveMinutes] = useState(0);
  const [demandLevel, setDemandLevel] = useState("NONE");
  const [ledRemainingSeconds, setLedRemainingSeconds] = useState(0);
  const [hasLedTimer, setHasLedTimer] = useState(false);
  const [systemMode, setSystemMode] = useState("Day Standby");
  const [trafficRate, setTrafficRate] = useState(0);
  const [trafficCategory, setTrafficCategory] = useState("all");
  const [energySeries, setEnergySeries] = useState(makeEnergySeries);
  const [trafficSeries, setTrafficSeries] = useState(makeTrafficSeries);
  const [activityLog, setActivityLog] = useState([]);
  const [historyLog, setHistoryLog] = useState([]);
  const [piezoSummary, setPiezoSummary] = useState(() => makePiezoSummary());
  const [piezoTrend, setPiezoTrend] = useState([]);
  const [mpptSeries, setMpptSeries] = useState([]);
  const [stepEvents, setStepEvents] = useState([]);
  const [hasReadingHistory, setHasReadingHistory] = useState(false);
  const [piezoAlerts, setPiezoAlerts] = useState([]);
  const [savedAlerts, setSavedAlerts] = useState(() => {
    if (typeof window === "undefined") {
      return [];
    }

    try {
      const storedAlerts = JSON.parse(
        window.localStorage.getItem("piezo-dashboard-alert-history") || "[]",
      );
      return Array.isArray(storedAlerts) ? storedAlerts : [];
    } catch {
      return [];
    }
  });
  const [connectionNotification, setConnectionNotification] = useState(() => {
    if (typeof window === "undefined") {
      return null;
    }

    try {
      return JSON.parse(
        window.localStorage.getItem(
          "piezo-dashboard-connection-notification",
        ) || "null",
      );
    } catch {
      return null;
    }
  });
  const [selectedTileId, setSelectedTileId] = useState("KineticGen");
  const deviceOnlineRef = useRef(false);
  const lastDeviceSnapshotAtRef = useRef(0);
  const hasInitialDeviceSnapshotRef = useRef(false);
  const hasStepEventsRef = useRef(false);
  const hasLiveStepStateRef = useRef(false);
  const currentFootstepAtRef = useRef(0);
  const ledTimerEndsAtRef = useRef(0);
  const ledReportedSecondsRef = useRef(null);
  const ledStepTimestampRef = useRef(0);
  const lastLiveCurrentStepRef = useRef(null);
  const hasLiveSystemModeRef = useRef(false);
  const firebaseConnectedRef = useRef(false);
  const previousDeviceStatusRef = useRef("unknown");
  const connectionStatusReadyRef = useRef(false);
  const tileMetadataRef = useRef({ tileId: "KineticGen", zone: "KineticGen" });
  const readingHistoryRef = useRef([]);
  const telemetryHistoryRef = useRef([]);
  const allHistoryReadingsRef = useRef([]);
  const historyClearedAtRef = useRef(0);
  const notificationButtonRef = useRef(null);

  const handleDashboardTouchStart = (event) => {
    if (event.touches.length !== 1) {
      dashboardTouchStartRef.current = null;
      return;
    }

    const target = event.target;
    if (target instanceof Element) {
      const interactiveTarget = target.closest(
        "button, a, input, textarea, select, [role='button'], [data-no-tab-swipe], .overflow-x-auto, .overflow-y-auto",
      );
      if (interactiveTarget) {
        dashboardTouchStartRef.current = null;
        return;
      }
    }

    const touch = event.touches[0];
    dashboardTouchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      axis: null,
    };
  };

  const handleDashboardTouchMove = (event) => {
    const start = dashboardTouchStartRef.current;
    if (!start || event.touches.length !== 1 || start.axis) {
      return;
    }

    const touch = event.touches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 12) {
      return;
    }

    if (Math.abs(deltaX) > Math.abs(deltaY) * 1.25) {
      start.axis = "horizontal";
    } else if (Math.abs(deltaY) > Math.abs(deltaX) * 1.1) {
      start.axis = "vertical";
    }
  };

  const navigateToSection = (section) => {
    scrollAndroidDashboardToTop();

    if (section === activeSection) {
      return;
    }

    setActiveSection(section);

    if (isAndroidApp) {
      void TabHaptics.tick().catch((error) => {
        console.warn("Unable to trigger tab haptic feedback.", error);
        if (typeof navigator !== "undefined" && navigator.vibrate) {
          navigator.vibrate(10);
        }
      });
    }
  };

  const handleDashboardTouchEnd = (event) => {
    const start = dashboardTouchStartRef.current;
    dashboardTouchStartRef.current = null;
    const touch = event.changedTouches[0];

    if (!start || start.axis !== "horizontal" || !touch) {
      return;
    }

    const deltaX = touch.clientX - start.x;
    if (Math.abs(deltaX) < 60) {
      return;
    }

    const currentIndex = DASHBOARD_SECTION_ORDER.indexOf(activeSection);
    const nextIndex = Math.max(
      0,
      Math.min(
        DASHBOARD_SECTION_ORDER.length - 1,
        currentIndex + (deltaX < 0 ? 1 : -1),
      ),
    );
    if (nextIndex !== currentIndex) {
      navigateToSection(DASHBOARD_SECTION_ORDER[nextIndex]);
    }
  };

  const handleOverviewPointerDown = (group, id, event) => {
    if (!isAndroidApp || event.button !== 0 || event.isPrimary === false) {
      return;
    }

    if (
      event.target instanceof Element &&
      event.target.closest(
        "button, a, input, textarea, select, [role='button']",
      )
    ) {
      return;
    }

    const pointerState = overviewPointerRef.current;
    window.clearTimeout(pointerState.timer);
    pointerState.pointerId = event.pointerId;
    pointerState.startX = event.clientX;
    pointerState.startY = event.clientY;
    pointerState.active = null;
    pointerState.hoveredId = id;
    pointerState.sourceElement = event.currentTarget;
    pointerState.ghost = null;
    pointerState.latestPointer = null;
    setDropTargetOverviewItem(null);
    pointerState.timer = window.setTimeout(() => {
      const sourceElement = pointerState.sourceElement;
      if (
        pointerState.pointerId !== event.pointerId ||
        !sourceElement?.isConnected
      ) {
        return;
      }

      const rect = sourceElement.getBoundingClientRect();
      const ghost = sourceElement.cloneNode(true);
      ghost.classList.remove("is-dragging", "is-drop-target");
      ghost.classList.add("overview-drag-ghost");
      ghost.removeAttribute("data-overview-drag-item");
      ghost.removeAttribute("data-overview-drag-group");
      ghost.removeAttribute("data-overview-drag-id");
      ghost.setAttribute("aria-hidden", "true");
      Object.assign(ghost.style, {
        position: "fixed",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: "0",
        zIndex: "1000",
        pointerEvents: "none",
        order: "initial",
      });
      document.querySelector(".android-app")?.appendChild(ghost);
      pointerState.ghost = ghost;
      pointerState.active = {
        group,
        id,
        offsetX: pointerState.startX - rect.left,
        offsetY: pointerState.startY - rect.top,
        originX: rect.left,
        originY: rect.top,
      };
      pointerState.timer = null;
      setDraggingOverviewItem({ group, id });
      setDropTargetOverviewItem(null);
      dashboardTouchStartRef.current = null;
    }, 350);
  };

  const getOverviewDragProps = (group, id, order) => ({
    ...(isAndroidApp
      ? {
          "data-overview-drag-item": "",
          "data-overview-drag-group": group,
          "data-overview-drag-id": id,
          style: { order: order.indexOf(id) },
          onPointerDown: (event) => handleOverviewPointerDown(group, id, event),
        }
      : {}),
  });

  const getOverviewDragClassName = (group, id) => {
    if (!isAndroidApp) {
      return "";
    }
    if (
      draggingOverviewItem?.group === group &&
      draggingOverviewItem.id === id
    ) {
      return "overview-draggable is-dragging";
    }
    if (
      dropTargetOverviewItem?.group === group &&
      dropTargetOverviewItem.id === id
    ) {
      return "overview-draggable is-drop-target";
    }
    return "overview-draggable";
  };

  useEffect(() => {
    if (!isAndroidApp) {
      return undefined;
    }

    const pointerState = overviewPointerRef.current;

    const handlePointerFrame = () => {
      pointerState.frame = null;
      const active = pointerState.active;
      const point = pointerState.latestPointer;
      if (!active || !point) {
        return;
      }

      if (pointerState.ghost) {
        const left = point.x - active.offsetX;
        const top = point.y - active.offsetY;
        pointerState.ghostPosition = {
          x: left - active.originX,
          y: top - active.originY,
        };
        pointerState.ghost.style.translate = `${pointerState.ghostPosition.x}px ${pointerState.ghostPosition.y}px`;
      }

      const target = document
        .elementFromPoint(point.x, point.y)
        ?.closest("[data-overview-drag-item]");
      if (!target || target.dataset.overviewDragGroup !== active.group) {
        pointerState.hoveredId = null;
        setDropTargetOverviewItem(null);
        return;
      }

      const targetId = target.dataset.overviewDragId;
      if (!targetId || targetId === active.id) {
        pointerState.hoveredId = targetId || null;
        setDropTargetOverviewItem(null);
        return;
      }
      if (targetId === pointerState.hoveredId) {
        return;
      }

      pointerState.hoveredId = targetId;
      pointerState.beforeRects = new Map(
        Array.from(
          document.querySelectorAll(
            `[data-overview-drag-group="${active.group}"]`,
          ),
        ).map((element) => [
          element.dataset.overviewDragId,
          element.getBoundingClientRect(),
        ]),
      );
      setDropTargetOverviewItem({
        group: active.group,
        id: targetId,
      });
      if (active.group === "metric") {
        setOverviewMetricOrder((order) =>
          swapOverviewOrder(order, active.id, targetId),
        );
      } else if (active.group === "chart") {
        setOverviewChartOrder((order) =>
          swapOverviewOrder(order, active.id, targetId),
        );
      } else {
        setPiezoMetricOrder((order) =>
          swapOverviewOrder(order, active.id, targetId),
        );
      }
    };

    const handlePointerMove = (event) => {
      if (event.pointerId !== pointerState.pointerId) {
        return;
      }

      if (!pointerState.active) {
        if (
          pointerState.timer !== null &&
          Math.hypot(
            event.clientX - pointerState.startX,
            event.clientY - pointerState.startY,
          ) > 10
        ) {
          window.clearTimeout(pointerState.timer);
          pointerState.timer = null;
        }
        return;
      }

      pointerState.latestPointer = { x: event.clientX, y: event.clientY };
      if (pointerState.ghost && pointerState.frame === null) {
        pointerState.frame = window.requestAnimationFrame(handlePointerFrame);
      }
    };

    const finishPointer = (event) => {
      if (
        event.pointerId !== undefined &&
        pointerState.pointerId !== null &&
        event.pointerId !== pointerState.pointerId
      ) {
        return;
      }
      window.clearTimeout(pointerState.timer);
      pointerState.timer = null;
      pointerState.pointerId = null;
      pointerState.active = null;
      pointerState.hoveredId = null;
      pointerState.ghost?.remove();
      pointerState.ghost = null;
      if (pointerState.frame !== null) {
        window.cancelAnimationFrame(pointerState.frame);
        pointerState.frame = null;
      }
      pointerState.ghostPosition = null;
      pointerState.latestPointer = null;
      pointerState.sourceElement = null;
      pointerState.beforeRects = null;
      setDraggingOverviewItem(null);
      setDropTargetOverviewItem(null);
    };

    const preventScrollDuringDrag = (event) => {
      if (pointerState.active && event.cancelable) {
        event.preventDefault();
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", finishPointer);
    document.addEventListener("touchmove", preventScrollDuringDrag, {
      passive: false,
    });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", finishPointer);
      document.removeEventListener("touchmove", preventScrollDuringDrag);
      window.clearTimeout(pointerState.timer);
      pointerState.timer = null;
      pointerState.pointerId = null;
      pointerState.active = null;
      pointerState.hoveredId = null;
      pointerState.ghost?.remove();
      pointerState.ghost = null;
      if (pointerState.frame !== null) {
        window.cancelAnimationFrame(pointerState.frame);
        pointerState.frame = null;
      }
      pointerState.ghostPosition = null;
      pointerState.latestPointer = null;
      pointerState.sourceElement = null;
      pointerState.beforeRects = null;
    };
  }, []);

  useLayoutEffect(() => {
    if (!isAndroidApp) {
      return;
    }

    const pointerState = overviewPointerRef.current;
    const beforeRects = pointerState.beforeRects;
    const group = pointerState.active?.group;
    if (!beforeRects || !group) {
      return;
    }

    pointerState.beforeRects = null;
    const elements = document.querySelectorAll(
      `[data-overview-drag-group="${group}"]`,
    );
    elements.forEach((element) => {
      const previousRect = beforeRects.get(element.dataset.overviewDragId);
      if (!previousRect) {
        return;
      }

      const nextRect = element.getBoundingClientRect();
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (deltaX === 0 && deltaY === 0) {
        return;
      }

      element.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: "translate(0, 0)" },
        ],
        {
          duration: 220,
          easing: "cubic-bezier(0.2, 0.75, 0.25, 1)",
        },
      );
    });
  }, [overviewMetricOrder, overviewChartOrder, piezoMetricOrder]);

  useEffect(() => {
    if (!isAndroidApp) {
      return;
    }
    try {
      window.localStorage.setItem(
        "piezo-overview-metric-order",
        JSON.stringify(overviewMetricOrder),
      );
    } catch {
      // Keep the in-memory card order if device storage is unavailable.
    }
  }, [overviewMetricOrder]);

  useEffect(() => {
    if (!isAndroidApp) {
      return;
    }
    try {
      window.localStorage.setItem(
        "piezo-overview-chart-order",
        JSON.stringify(overviewChartOrder),
      );
    } catch {
      // Keep the in-memory chart order if device storage is unavailable.
    }
  }, [overviewChartOrder]);

  useEffect(() => {
    if (!isAndroidApp) {
      return;
    }
    try {
      window.localStorage.setItem(
        "piezo-tile-metric-order",
        JSON.stringify(piezoMetricOrder),
      );
    } catch {
      // Keep the in-memory card order if device storage is unavailable.
    }
  }, [piezoMetricOrder]);

  const isNight = dayNightStatus === "Night";
  const isDark = themeMode === "dark";
  const displayedSystemStatus = deviceDataLoading ? "Loading" : systemStatus;
  const ledLightStatus =
    displayedSystemStatus !== "Online" || !hasLedTimer
      ? "Unavailable"
      : ledRemainingSeconds > 0
        ? "ON"
        : "OFF";
  const toggleTheme = () =>
    setThemeMode((previousTheme) => {
      const nextTheme = previousTheme === "dark" ? "light" : "dark";
      window.localStorage.setItem("piezo-dashboard-theme", nextTheme);
      return nextTheme;
    });

  const currentAlerts = mergeAlerts([
    ...piezoAlerts,
    ...(connectionNotification ? [connectionNotification] : []),
  ]);

  useEffect(() => {
    if (currentAlerts.length === 0) {
      return;
    }

    setSavedAlerts((previous) => mergeAlerts([...currentAlerts, ...previous]));
  }, [piezoAlerts, connectionNotification]);

  useEffect(() => {
    window.localStorage.setItem(
      "piezo-dashboard-alert-history",
      JSON.stringify(savedAlerts),
    );
  }, [savedAlerts]);

  const updateNotificationMenuPosition = () => {
    if (!notificationButtonRef.current) {
      return;
    }

    const buttonBounds = notificationButtonRef.current.getBoundingClientRect();
    const viewportMargin = 16;
    const menuWidth = Math.min(288, window.innerWidth - viewportMargin * 2);
    const left = Math.max(
      viewportMargin,
      Math.min(
        buttonBounds.left + buttonBounds.width / 2 - menuWidth / 2,
        window.innerWidth - menuWidth - viewportMargin,
      ),
    );
    setNotificationMenuPosition({
      left,
      top: buttonBounds.bottom + 12,
      width: menuWidth,
      right: "auto",
      maxWidth: `calc(100vw - ${viewportMargin * 2}px)`,
    });
  };

  const recordConnectionStatus = (nextStatus) => {
    const previousStatus = previousDeviceStatusRef.current;

    if (previousStatus === "unknown") {
      previousDeviceStatusRef.current = nextStatus;
      return;
    }

    if (previousStatus === nextStatus) {
      return;
    }

    previousDeviceStatusRef.current = nextStatus;
    if (!connectionStatusReadyRef.current) {
      connectionStatusReadyRef.current = true;
      return;
    }

    const connected = nextStatus === "Online";
    setConnectionNotification({
      id: `connection-${nextStatus.toLowerCase()}-${Date.now()}`,
      message: connected
        ? "System connected. A recent ESP32 update was received."
        : "System disconnected. No recent ESP32 update was received.",
      severity: connected ? "info" : "high",
    });
  };

  useEffect(() => {
    if (!showNotifications || !notificationButtonRef.current) {
      return undefined;
    }

    updateNotificationMenuPosition();
    window.addEventListener("resize", updateNotificationMenuPosition);
    window.addEventListener("scroll", updateNotificationMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateNotificationMenuPosition);
      window.removeEventListener(
        "scroll",
        updateNotificationMenuPosition,
        true,
      );
    };
  }, [showNotifications]);

  useEffect(() => {
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
  }, [isDark]);

  useEffect(() => {
    recordConnectionStatus(systemStatus);
  }, [systemStatus]);

  useEffect(() => {
    const intervalId = window.setInterval(
      () => setCurrentDateTime(new Date()),
      1000,
    );
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      "piezo-dashboard-dismissed-alerts",
      JSON.stringify([...dismissedNotificationIds]),
    );
  }, [dismissedNotificationIds]);

  useEffect(() => {
    window.localStorage.setItem(
      "piezo-dashboard-read-alerts",
      JSON.stringify([...readNotificationIds]),
    );
  }, [readNotificationIds]);

  useEffect(() => {
    if (connectionNotification) {
      window.localStorage.setItem(
        "piezo-dashboard-connection-notification",
        JSON.stringify(connectionNotification),
      );
    } else {
      window.localStorage.removeItem("piezo-dashboard-connection-notification");
    }
  }, [connectionNotification]);

  const visibleNotifications = piezoAlerts.filter(
    (alert) => !dismissedNotificationIds.has(alert.id),
  );
  const navigationAlerts = mergeAlerts([
    ...savedAlerts,
    ...piezoAlerts,
    ...(connectionNotification ? [connectionNotification] : []),
  ]);
  const visibleNavigationAlerts = navigationAlerts.filter(
    (alert) => !dismissedNotificationIds.has(alert.id),
  );
  const bellNotifications = mergeAlerts([
    ...savedAlerts,
    ...piezoAlerts,
    ...(connectionNotification ? [connectionNotification] : []),
  ]);
  const visibleBellNotifications = bellNotifications.filter(
    (alert) => !notificationDismissedIds.has(alert.id),
  );
  const unreadAlerts = visibleBellNotifications.filter(
    (alert) => !readNotificationIds.has(alert.id),
  );

  const cardClass = isDark
    ? "rounded-2xl border border-white/[0.08] bg-[#0b0b0b] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.28)]"
    : isAndroidApp
      ? "rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_4px_18px_rgba(15,23,42,0.06)]"
      : "rounded-2xl border border-slate-300 bg-slate-100 p-4 shadow-[0_8px_24px_rgba(71,85,105,0.14)]";
  const headerClass = isDark
    ? "rounded-2xl border border-white/[0.1] bg-[#0e0e0e] p-5 shadow-[0_16px_36px_rgba(0,0,0,0.34)]"
    : "rounded-2xl border border-slate-300 bg-slate-100 p-5 shadow-[0_8px_24px_rgba(71,85,105,0.14)]";
  const mutedText = isDark ? "text-neutral-300" : "text-slate-600";
  const subtleText = isDark ? "text-neutral-400" : "text-slate-600";
  const strongText = isDark ? "text-white" : "text-slate-900";
  const chipBase = isDark
    ? "border-white/[0.12] bg-[#151515] text-neutral-200 hover:border-white/[0.2] hover:bg-[#1b1b1b]"
    : isAndroidApp
      ? "border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50"
      : "border-slate-400 bg-slate-200 text-slate-800 shadow-sm hover:border-slate-500 hover:bg-slate-300";

  const mergeUniqueById = (items) => {
    const seen = new Set();
    const uniqueItems = [];

    for (const item of items) {
      if (!item || !item.id || seen.has(item.id)) {
        continue;
      }

      seen.add(item.id);
      uniqueItems.push(item);
    }

    return uniqueItems;
  };

  const applyLatestTelemetry = (data) => {
    if (!data) {
      return;
    }

    if (typeof data.mode === "string" && !hasLiveSystemModeRef.current) {
      setSystemMode(data.mode);
    }
    if (data.energyPoint !== undefined) {
      setEnergySeries((prev) => [
        ...prev.slice(-23),
        {
          time: new Date(
            toNumber(data.lastUpdate, Date.now()),
          ).toLocaleTimeString(),
          value: toNumber(data.energyPoint),
        },
      ]);
    }
    if (data.entry) {
      setActivityLog((prev) =>
        mergeUniqueById([data.entry, ...prev]).slice(0, 6),
      );
      setHistoryLog((prev) =>
        mergeUniqueById([data.entry, ...prev]).slice(0, 12),
      );
    }
  };

  const applyHistoryEntries = (entries) => {
    setHistoryLog(
      mergeUniqueById(entries)
        .filter((entry) => {
          const timestamp = getTimestampMs(entry.timestamp);
          return (
            historyClearedAtRef.current === 0 ||
            timestamp === 0 ||
            timestamp > historyClearedAtRef.current
          );
        })
        .slice(0, 12),
    );
  };

  useEffect(() => {
    if (!firebaseAuth) {
      setAuthLoading(false);
      return undefined;
    }

    let unsubscribe;
    let active = true;

    authPersistenceReady
      .then(() => {
        if (!active) {
          return;
        }

        unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
          if (user && !user.emailVerified) {
            setVerificationPending(true);
            setAuthUser(null);
            setAuthNotice(
              "Verification email sent. Verify your email and this page will continue automatically.",
            );
            setAuthLoading(false);
            return;
          }

          setVerificationPending(false);
          setAuthUser(user);
          setAuthLoading(false);
        });
      })
      .catch((error) => {
        console.error("Unable to configure Firebase auth persistence:", error);
        if (active) {
          setAuthLoading(false);
          setAuthError(
            "Unable to initialize secure sign-in. Please reload the page.",
          );
        }
      });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!authUser) {
      setEmail("");
      setPassword("");
      setConfirmPassword("");
    }
  }, [authUser]);

  useEffect(() => {
    if (!authUser || typeof window === "undefined") {
      return undefined;
    }

    const checkLastActivity = () => {
      const lastActivity = Number(
        window.localStorage.getItem(AUTH_ACTIVITY_STORAGE_KEY),
      );
      if (
        lastActivity > 0 &&
        Date.now() - lastActivity >= AUTH_INACTIVITY_TIMEOUT_MS
      ) {
        void signOutFirebaseUser();
        return true;
      }

      return false;
    };

    if (checkLastActivity()) {
      return undefined;
    }

    if (!window.localStorage.getItem(AUTH_ACTIVITY_STORAGE_KEY)) {
      window.localStorage.setItem(
        AUTH_ACTIVITY_STORAGE_KEY,
        String(Date.now()),
      );
    }

    let activityWriteTimeout;
    const recordActivity = () => {
      if (activityWriteTimeout) {
        return;
      }

      window.localStorage.setItem(
        AUTH_ACTIVITY_STORAGE_KEY,
        String(Date.now()),
      );
      activityWriteTimeout = window.setTimeout(() => {
        activityWriteTimeout = undefined;
      }, 1000);
    };

    const activityEvents = ["pointerdown", "keydown", "scroll", "touchstart"];
    activityEvents.forEach((eventName) =>
      window.addEventListener(eventName, recordActivity, { passive: true }),
    );
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") {
        checkLastActivity();
      }
    };
    document.addEventListener("visibilitychange", checkWhenVisible);
    const intervalId = window.setInterval(checkLastActivity, 60 * 1000);

    return () => {
      activityEvents.forEach((eventName) =>
        window.removeEventListener(eventName, recordActivity),
      );
      document.removeEventListener("visibilitychange", checkWhenVisible);
      window.clearInterval(intervalId);
      window.clearTimeout(activityWriteTimeout);
    };
  }, [authUser]);

  useEffect(() => {
    if (
      !firebaseAuth ||
      authUser ||
      !verificationPending ||
      !firebaseAuth.currentUser
    ) {
      return undefined;
    }

    const checkVerification = async () => {
      try {
        const user = await refreshFirebaseUser();
        if (user?.emailVerified) {
          setVerificationPending(false);
          setAuthUser(user);
          setAuthNotice("Email verified. You are now signed in.");
        }
      } catch (error) {
        console.error("Unable to check email verification:", error);
      }
    };

    checkVerification();
    const intervalId = window.setInterval(checkVerification, 3000);
    return () => window.clearInterval(intervalId);
  }, [authUser, verificationPending]);

  useEffect(() => {
    if (!firebaseReady || !firebaseDb || !authUser) {
      return undefined;
    }

    setDatabaseError("");
    setDeviceDataLoading(true);
    setSystemStatus("Loading");
    deviceOnlineRef.current = false;
    firebaseConnectedRef.current = false;
    ledTimerEndsAtRef.current = 0;
    ledReportedSecondsRef.current = null;
    ledStepTimestampRef.current = 0;
    setLedRemainingSeconds(0);
    setHasLedTimer(false);

    const kineticGenRef = ref(firebaseDb, "KineticGen");
    const telemetryRef = ref(firebaseDb, "telemetry/latest");
    const historyRef = ref(firebaseDb, "telemetry/history");
    const historyClearedAtRefPath = ref(
      firebaseDb,
      "telemetry/historyClearedAt",
    );
    const connectionRef = ref(firebaseDb, ".info/connected");
    const readingsRef = query(
      ref(firebaseDb, "readings"),
      orderByKey(),
      limitToLast(MAX_INITIAL_READING_HISTORY),
    );
    const stepsRef = query(
      ref(firebaseDb, "steps"),
      orderByKey(),
      limitToLast(2000),
    );
    const initialDeviceLoadTimeoutId = window.setTimeout(() => {
      if (!hasInitialDeviceSnapshotRef.current) {
        setDeviceDataLoading(false);
        setSystemStatus("Offline");
      }
    }, INITIAL_DEVICE_LOAD_TIMEOUT_MS);
    const handlePageResume = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      window.clearTimeout(initialDeviceLoadTimeoutId);
      const isDeviceOnline =
        firebaseConnectedRef.current &&
        isRecentDeviceUpdate(lastDeviceSnapshotAtRef.current);
      deviceOnlineRef.current = isDeviceOnline;
      setDeviceDataLoading(false);
      setSystemStatus(isDeviceOnline ? "Online" : "Offline");
      if (!isDeviceOnline) {
        setDayNightStatus("Unavailable");
        setLdrStatus("Unavailable");
      }
    };
    document.addEventListener("visibilitychange", handlePageResume);
    window.addEventListener("pageshow", handlePageResume);
    window.addEventListener("focus", handlePageResume);

    const runTelemetryCleanup = () => {
      cleanupFirebaseTelemetry().catch((error) => {
        console.error("Unable to clean up old Firebase telemetry:", error);
      });
    };
    runTelemetryCleanup();
    const telemetryCleanupIntervalId = window.setInterval(
      runTelemetryCleanup,
      15 * 60 * 1000,
    );
    const unsubscribeConnection = onValue(
      connectionRef,
      (snapshot) => {
        const connected = snapshot.val() === true;
        firebaseConnectedRef.current = connected;
        setFirebaseConnected(connected);
        if (!connected) {
          setSystemStatus("Offline");
          setDayNightStatus("Unavailable");
          setLdrStatus("Unavailable");
        } else if (deviceOnlineRef.current) {
          setSystemStatus("Online");
        }
      },
      (error) => {
        console.error("Firebase connection listener failed:", error);
        setDatabaseError(
          error.message || "Unable to connect to Firebase Realtime Database.",
        );
        setFirebaseConnected(false);
        setSystemStatus("Offline");
        setDayNightStatus("Unavailable");
        setLdrStatus("Unavailable");
      },
    );
    const unsubscribeKineticGen = onValue(kineticGenRef, (snapshot) => {
      const data = snapshot.val();
      const isInitialSnapshot = !hasInitialDeviceSnapshotRef.current;
      hasInitialDeviceSnapshotRef.current = true;
      if (isInitialSnapshot) {
        window.clearTimeout(initialDeviceLoadTimeoutId);
        setDeviceDataLoading(false);
      }

      if (!data) {
        lastDeviceSnapshotAtRef.current = 0;
        deviceOnlineRef.current = false;
        hasLiveSystemModeRef.current = false;
        hasLiveStepStateRef.current = false;
        currentFootstepAtRef.current = 0;
        lastLiveCurrentStepRef.current = null;
        setCurrentFootstep(0);
        setStepsLastFiveMinutes(0);
        setDemandLevel("NONE");
        setLedRemainingSeconds(0);
        setHasLedTimer(false);
        ledTimerEndsAtRef.current = 0;
        ledReportedSecondsRef.current = null;
        ledStepTimestampRef.current = 0;
        setDayNightStatus("Unavailable");
        setLdrStatus("Unavailable");
        tileMetadataRef.current = { tileId: "KineticGen", zone: "KineticGen" };
        setPiezoSummary(makePiezoSummary());
        setPiezoAlerts([]);
        return;
      }

      const summary = makePiezoSummary(data);
      hasLiveStepStateRef.current =
        data.footsteps !== undefined ||
        data.steps !== undefined ||
        data.currentStep !== undefined ||
        data.lastStepAt !== undefined;
      const updateTime = getTimestampMs(getDeviceUpdateValue(data));
      lastDeviceSnapshotAtRef.current = updateTime;
      if (data.deviceOnline === false) {
        deviceOnlineRef.current = false;
        setSystemStatus("Offline");
        currentFootstepAtRef.current = 0;
        lastLiveCurrentStepRef.current = 0;
        setCurrentFootstep(0);
        setDayNightStatus("Unavailable");
        setLdrStatus("Unavailable");
      } else if (updateTime > 0 && isRecentDeviceUpdate(updateTime)) {
        deviceOnlineRef.current = true;
        setLastDeviceUpdate(updateTime);
        lastDeviceSnapshotAtRef.current = updateTime;
        setSystemStatus(firebaseConnectedRef.current ? "Online" : "Offline");
        const stepValue = toNumber(data.currentStep);
        lastLiveCurrentStepRef.current = stepValue;
        currentFootstepAtRef.current =
          stepValue > 0 ? getTimestampMs(data.lastStepAt) || Date.now() : 0;
        setCurrentFootstep(stepValue);
      } else if (updateTime > 0) {
        deviceOnlineRef.current = false;
        setLastDeviceUpdate(updateTime);
        lastDeviceSnapshotAtRef.current = updateTime;
        setSystemStatus("Offline");
        currentFootstepAtRef.current = 0;
        lastLiveCurrentStepRef.current = 0;
        setCurrentFootstep(0);
        setDayNightStatus("Unavailable");
        setLdrStatus("Unavailable");
      } else {
        deviceOnlineRef.current = false;
        setLastDeviceUpdate(0);
        setSystemStatus("Offline");
        currentFootstepAtRef.current = 0;
        lastLiveCurrentStepRef.current = 0;
        setCurrentFootstep(0);
        setDayNightStatus("Unavailable");
        setLdrStatus("Unavailable");
      }
      setStepsLastFiveMinutes(toNumber(data.stepsLast5Minutes));
      setDemandLevel(
        typeof data.demandLevel === "string" ? data.demandLevel : "NONE",
      );
      if (
        typeof data.isDark === "boolean" &&
        typeof data.demandLevel === "string"
      ) {
        hasLiveSystemModeRef.current = true;
        setSystemMode(
          getSystemModeFromLiveState(data.isDark, data.demandLevel),
        );
      }
      const reportedLedSeconds = Number(data.ledRemainingSeconds);
      const hasReportedLedTimer =
        data.ledRemainingSeconds !== undefined &&
        data.ledRemainingSeconds !== null &&
        data.ledRemainingSeconds !== "" &&
        Number.isFinite(reportedLedSeconds);
      if (hasReportedLedTimer) {
        const reportedStepTimestamp = getTimestampMs(data.lastStepAt);
        const isNewFootstep =
          reportedStepTimestamp > 0 &&
          reportedStepTimestamp !== ledStepTimestampRef.current;
        if (reportedStepTimestamp > 0) {
          ledStepTimestampRef.current = reportedStepTimestamp;
        }

        if (
          isNewFootstep ||
          ledReportedSecondsRef.current !== reportedLedSeconds
        ) {
          ledReportedSecondsRef.current = reportedLedSeconds;
          ledTimerEndsAtRef.current =
            reportedLedSeconds > 0
              ? Date.now() + reportedLedSeconds * 1000
              : 0;
          setLedRemainingSeconds(Math.max(0, Math.ceil(reportedLedSeconds)));
        }
        setHasLedTimer(true);
      } else {
        ledTimerEndsAtRef.current = 0;
        ledReportedSecondsRef.current = null;
        setLedRemainingSeconds(0);
        setHasLedTimer(false);
      }
      const ldrValue = Number(data.ldrValue);
      const hasValidLdrValue = Number.isFinite(ldrValue);
      if (
        deviceOnlineRef.current &&
        firebaseConnectedRef.current &&
        hasValidLdrValue
      ) {
        const detectedDayNight =
          typeof data.isDark === "boolean"
            ? data.isDark
              ? "Night"
              : "Day"
            : getDayNightFromLdr(ldrValue);
        setDayNightStatus(detectedDayNight);
        setLdrStatus(detectedDayNight);
      } else {
        setDayNightStatus("Unavailable");
        setLdrStatus("Unavailable");
      }
      tileMetadataRef.current = {
        tileId: summary.tiles[0].tileId,
        zone: summary.tiles[0].zone,
      };
      const connectedStatus = deviceOnlineRef.current ? "active" : "offline";
      summary.tiles[0].status = connectedStatus;
      summary.activeTiles = connectedStatus === "active" ? 1 : 0;
      summary.offlineTiles = connectedStatus === "offline" ? 1 : 0;
      setPiezoSummary(summary);
      setPiezoAlerts(isInitialSnapshot ? [] : makeAlerts(summary));
    }, (error) => {
      console.error("Firebase device listener failed:", error);
      window.clearTimeout(initialDeviceLoadTimeoutId);
      setDeviceDataLoading(false);
      setDatabaseError(
        error.message || "Unable to load device data from Firebase.",
      );
      deviceOnlineRef.current = false;
      ledTimerEndsAtRef.current = 0;
      setLedRemainingSeconds(0);
      setHasLedTimer(false);
      setSystemStatus("Offline");
      setDayNightStatus("Unavailable");
      setLdrStatus("Unavailable");
    });

    const unsubscribeLatest = onValue(telemetryRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) {
        setSystemMode("Day Standby");
        setEnergySeries([]);
        setActivityLog([]);
        return;
      }

      applyLatestTelemetry(data);
    });

    const unsubscribeHistory = onValue(historyRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) {
        telemetryHistoryRef.current = [];
        applyHistoryEntries(readingHistoryRef.current);
        return;
      }
      const list = Object.entries(data)
        .filter(
          ([key, entry]) =>
            key !== CLEARED_NODE_KEY &&
            entry !== null &&
            typeof entry === "object",
        )
        .slice(-12)
        .reverse()
        .map(([key, entry]) => ({
          ...entry,
          id: entry.id ?? key,
          timestamp: entry.timestamp ?? key,
        }));
      telemetryHistoryRef.current = list;
      applyHistoryEntries(
        readingHistoryRef.current.length > 0 ? readingHistoryRef.current : list,
      );
    });

    const unsubscribeHistoryReset = onValue(
      historyClearedAtRefPath,
      (snapshot) => {
        historyClearedAtRef.current = getTimestampMs(snapshot.val());
        applyHistoryEntries(
          allHistoryReadingsRef.current.length > 0
            ? allHistoryReadingsRef.current
            : telemetryHistoryRef.current,
        );
      },
    );

    const unsubscribeReadings = onValue(readingsRef, (snapshot) => {
      const data = snapshot.val();
      const entries =
        data && typeof data === "object"
          ? Object.entries(data)
              .filter(([key]) => key !== CLEARED_NODE_KEY)
              .map(([key, value]) => ({
                ...value,
                timestamp: value.timestamp ?? key,
              }))
          : [];
      if (entries.length === 0) {
        readingHistoryRef.current = [];
        allHistoryReadingsRef.current = [];
        setHasReadingHistory(false);
        applyHistoryEntries(telemetryHistoryRef.current);
        setEnergyTotal(0);
        setPiezoTrend([]);
        setMpptSeries([]);
        return;
      }
      setHasReadingHistory(true);
      const cutoff = Date.now() - 24 * 3600000;
      const ordered = entries
        .filter((entry) => getTimestampMs(entry.timestamp) >= cutoff)
        .sort(
          (a, b) => getTimestampMs(a.timestamp) - getTimestampMs(b.timestamp),
        );
      if (ordered.length === 0) {
        setHasReadingHistory(false);
        readingHistoryRef.current = [];
        allHistoryReadingsRef.current = [];
        applyHistoryEntries(telemetryHistoryRef.current);
        setEnergyTotal(0);
        setPiezoTrend([]);
        setMpptSeries([]);
        return;
      }
      let sessionEnergy = 0;
      const withEnergy = ordered.map((entry, index) => {
        const previous = ordered[index - 1];
        const elapsedMs = previous
          ? getTimestampMs(entry.timestamp) - getTimestampMs(previous.timestamp)
          : 0;
        const elapsedHours =
          elapsedMs > 0 && elapsedMs <= MAX_ENERGY_SAMPLE_GAP_MS
            ? elapsedMs / 3600000
            : 0;
        const currentPower = getGeneratedPower(entry);
        const previousPower = previous
          ? getGeneratedPower(previous)
          : currentPower;
        const intervalEnergy =
          ((previousPower + currentPower) / 2) * elapsedHours;
        sessionEnergy += intervalEnergy;
        return {
          ...entry,
          timestampMs: getTimestampMs(entry.timestamp),
          time: new Date(getTimestampMs(entry.timestamp)).toLocaleTimeString(),
          energy: sessionEnergy,
          intervalEnergy,
          power: currentPower,
          vref: toNumber(entry.Vref_V),
          direction: toNumber(entry.Direction),
          previousPower:
            entry.PreviousPower_mW !== undefined
              ? toNumber(entry.PreviousPower_mW)
              : null,
          previousVref:
            entry.PreviousVref_V !== undefined
              ? toNumber(entry.PreviousVref_V)
              : null,
          stepV: entry.Step_V !== undefined ? toNumber(entry.Step_V) : null,
          decision: entry.Decision ?? entry.decision ?? "",
        };
      });
      const latest = withEnergy[withEnergy.length - 1];
      const historyReadings = withEnergy
        .slice(-12)
        .reverse()
        .map((entry) => ({
          id: `reading-${entry.timestamp}`,
          timestamp: entry.timestamp,
          timestampMs: entry.timestampMs,
          location: tileMetadataRef.current.zone,
          Voltage_V: toNumber(entry.Voltage_V),
          Current_mA: toNumber(entry.Current_mA),
          Power_mW: toNumber(entry.Power_mW),
          energy_mWh: entry.energy,
        }));
      readingHistoryRef.current = historyReadings;
      allHistoryReadingsRef.current = historyReadings;
      applyHistoryEntries(historyReadings);
      setEnergyTotal(sessionEnergy);
      setPiezoTrend(
        withEnergy.map(({ timestampMs, time, intervalEnergy, power }) => ({
          timestampMs,
          time,
          intervalEnergy,
          power,
        })),
      );
      setMpptSeries(
        withEnergy.map(
          ({
            time,
            power,
            vref,
            direction,
            previousPower,
            previousVref,
            stepV,
            decision,
          }) => ({
            time,
            power,
            vref,
            direction,
            previousPower,
            previousVref,
            stepV,
            decision,
          }),
        ),
      );
      setPiezoSummary((previous) => ({
        ...previous,
        totalEnergy: sessionEnergy,
        totalPower: latest.power,
        totalVoltage: toNumber(latest.Voltage_V),
        tiles: previous.tiles.map((tile) => ({
          ...tile,
          voltage: toNumber(latest.Voltage_V),
          current: toNumber(latest.Current_mA) / 1000,
          power: latest.power,
          energy: sessionEnergy,
          timestamp: getTimestampMs(latest.timestamp),
        })),
      }));
    });

    let latestStepEvents = [];
    const updateStepsTotal = () => {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      setStepsTotal(
        latestStepEvents
          .filter((event) => getTimestampMs(event.timestamp) >= cutoff)
          .reduce((total, event) => total + event.count, 0),
      );
    };
    const unsubscribeSteps = onValue(stepsRef, (snapshot) => {
      const data = snapshot.val();
      const events =
        data && typeof data === "object"
          ? Object.entries(data)
              .filter(([key]) => key !== CLEARED_NODE_KEY)
              .filter(([, value]) => {
                const count = Number(value?.count ?? value?.steps);
                return Number.isFinite(count) && count > 0;
              })
              .map(([key, value]) => ({
                timestamp: value.timestamp ?? key,
                count: toNumber(value.count ?? value.steps),
              }))
          : [];
      hasStepEventsRef.current = events.length > 0;
      latestStepEvents = events;
      setStepEvents(events);
      updateStepsTotal();
      if (events.length > 0) {
        const latestEvent = [...events].sort(
          (first, second) =>
            getTimestampMs(first.timestamp) - getTimestampMs(second.timestamp),
        )[events.length - 1];
        setTrafficRate(latestEvent.count);
        if (
          hasInitialDeviceSnapshotRef.current &&
          !hasLiveStepStateRef.current
        ) {
          const latestEventTime = getTimestampMs(latestEvent.timestamp);
          setCurrentFootstep(latestEvent.count > 0 ? latestEvent.count : 0);
          currentFootstepAtRef.current =
            latestEvent.count > 0 && latestEventTime > 0 ? latestEventTime : 0;
        }
      }
    });
    const stepsTotalIntervalId = window.setInterval(updateStepsTotal, 60_000);
    const deviceStatusIntervalId = window.setInterval(() => {
      const heartbeatTime = lastDeviceSnapshotAtRef.current;
      const isDeviceOnline =
        firebaseConnectedRef.current && isRecentDeviceUpdate(heartbeatTime);
      const remainingLedSeconds =
        ledTimerEndsAtRef.current > 0
          ? Math.max(
              0,
              Math.ceil((ledTimerEndsAtRef.current - Date.now()) / 1000),
            )
          : 0;

      deviceOnlineRef.current = isDeviceOnline;
      setSystemStatus(isDeviceOnline ? "Online" : "Offline");
      setLedRemainingSeconds((previous) =>
        previous === remainingLedSeconds ? previous : remainingLedSeconds,
      );
      if (!isDeviceOnline) {
        setDayNightStatus("Unavailable");
        setLdrStatus("Unavailable");
        setCurrentFootstep(0);
        currentFootstepAtRef.current = 0;
      }
      if (!isDeviceOnline && heartbeatTime > 0) {
        setPiezoSummary((previous) => ({
          ...previous,
          activeTiles: 0,
          offlineTiles: previous.tiles.length,
          tiles: previous.tiles.map((tile) => ({
            ...tile,
            status: "offline",
          })),
        }));
      }
    }, 1000);

    return () => {
      hasInitialDeviceSnapshotRef.current = false;
      lastDeviceSnapshotAtRef.current = 0;
      hasStepEventsRef.current = false;
      hasLiveStepStateRef.current = false;
      currentFootstepAtRef.current = 0;
      lastLiveCurrentStepRef.current = null;
      unsubscribeConnection();
      unsubscribeKineticGen();
      unsubscribeLatest();
      unsubscribeHistory();
      unsubscribeHistoryReset();
      unsubscribeReadings();
      unsubscribeSteps();
      document.removeEventListener("visibilitychange", handlePageResume);
      window.removeEventListener("pageshow", handlePageResume);
      window.removeEventListener("focus", handlePageResume);
      window.clearTimeout(initialDeviceLoadTimeoutId);
      window.clearInterval(deviceStatusIntervalId);
      window.clearInterval(telemetryCleanupIntervalId);
      window.clearInterval(stepsTotalIntervalId);
    };
  }, [authUser]);

  const sparkline = useMemo(
    () =>
      energySeries.slice(-10).map((item, index) => ({
        index,
        value: item.value,
      })),
    [energySeries],
  );

  const handleExport = () => {
    const header = [
      "timestamp",
      "location",
      "voltage_v",
      "current_ma",
      "power_mw",
      "energy_mwh",
    ];
    const rows = historyLog.map((entry) => [
      formatHistoryTimestamp(entry),
      getHistoryLocation(entry),
      entry.Voltage_V ?? entry.voltage ?? "",
      entry.Current_mA ?? entry.current_mA ?? "",
      entry.Power_mW ?? entry.power_mW ?? "",
      entry.energy_mWh ?? "",
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((value) => `"${value}"`).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "piezo-activity-log.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const trafficLegend = [
    { id: "low", label: "Low", color: "#34d399" },
    { id: "medium", label: "Medium", color: "#38bdf8" },
    { id: "high", label: "High", color: "#f97316" },
  ];

  const selectedTile =
    piezoSummary.tiles.find((tile) => tile.tileId === selectedTileId) ??
    piezoSummary.tiles[0];
  const getHistoryLocation = (entry) =>
    entry.location ||
    tileMetadataRef.current.zone ||
    tileMetadataRef.current.tileId;

  const [editingZoneTileId, setEditingZoneTileId] = useState(null);
  const [zoneDraft, setZoneDraft] = useState("");
  const [editingTileNameId, setEditingTileNameId] = useState(null);
  const [tileNameDraft, setTileNameDraft] = useState("");

  const handleRenameZone = async (tileId, newZone) => {
    const trimmed = newZone.trim();
    if (!trimmed) {
      setEditingZoneTileId(null);
      setZoneDraft("");
      return;
    }

    try {
      await updateFirebaseTileMetadata({ zone: trimmed });
      setPiezoSummary((prev) => ({
        ...prev,
        tiles: prev.tiles.map((tile) =>
          tile.tileId === tileId ? { ...tile, zone: trimmed } : tile,
        ),
      }));
      tileMetadataRef.current.zone = trimmed;
      setEditingZoneTileId(null);
      setZoneDraft("");
    } catch (error) {
      console.error("Unable to save tile zone:", error);
    }
  };

  const handleRenameTile = async (tileId, newName) => {
    const trimmed = newName.trim();
    if (!trimmed) {
      setEditingTileNameId(null);
      setTileNameDraft("");
      return;
    }

    try {
      await updateFirebaseTileMetadata({ tileName: trimmed });
      setPiezoSummary((prev) => ({
        ...prev,
        tiles: prev.tiles.map((tile) =>
          tile.tileId === tileId ? { ...tile, tileId: trimmed } : tile,
        ),
      }));
      tileMetadataRef.current.tileId = trimmed;
      setSelectedTileId(trimmed);
      setEditingTileNameId(null);
      setTileNameDraft("");
    } catch (error) {
      console.error("Unable to save tile name:", error);
    }
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    setAuthError("");
    setAuthNotice("");

    if (authSubmitting) {
      return;
    }

    if (
      !email ||
      (authMode !== "reset" && !password) ||
      (authMode === "create" && !confirmPassword)
    ) {
      setAuthError(
        authMode === "reset"
          ? "Enter your email address."
          : "Enter both email and password.",
      );
      return;
    }

    if (authMode === "create" && password !== confirmPassword) {
      setAuthError("Passwords do not match.");
      return;
    }

    try {
      setAuthSubmitting(true);

      if (authMode === "reset") {
        await sendFirebasePasswordReset(email);
        setAuthMode("signin");
        setAuthNotice(
          "Password reset email sent. Check your inbox to create a new password.",
        );
      } else if (authMode === "create") {
        await createFirebaseUser(email, password);
        setAuthMode("signin");
        setPassword("");
        setConfirmPassword("");
        setAuthNotice(
          "Account created. Check your email, verify your address, then sign in.",
        );
      } else {
        const credentials = await signInFirebaseUser(email, password);
        setVerificationPending(false);
        setAuthUser(credentials.user);
      }
    } catch (error) {
      if (error?.code === "auth/email-not-verified") {
        setAuthError(
          "Please verify your email before signing in. Check your inbox, then try again.",
        );
      } else if (error?.code === "auth/email-already-in-use") {
        setAuthError(
          "This email is already registered. Sign in instead or use another email.",
        );
      } else {
        setAuthError(error?.message || "Authentication failed.");
      }
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleCreateAccount = async (event) => {
    event.preventDefault();
    setCreateAccountError("");
    setCreatedAccountEmail("");

    const trimmedEmail = newAccountEmail.trim();
    if (!trimmedEmail || !newAccountPassword || !newAccountConfirmPassword) {
      setCreateAccountError("Enter an email address and both password fields.");
      return;
    }

    if (newAccountPassword.length < 6) {
      setCreateAccountError("Your password must be at least 6 characters.");
      return;
    }

    if (newAccountPassword !== newAccountConfirmPassword) {
      setCreateAccountError("Passwords do not match.");
      return;
    }

    try {
      setCreatingAccount(true);
      await createFirebaseUser(trimmedEmail, newAccountPassword);
      setCreatedAccountEmail(trimmedEmail);
      setNewAccountEmail("");
      setNewAccountPassword("");
      setNewAccountConfirmPassword("");
    } catch (error) {
      if (error?.code === "auth/email-already-in-use") {
        setCreateAccountError(
          "This email is already registered. Use a different email address.",
        );
      } else if (error?.code === "auth/invalid-email") {
        setCreateAccountError("Enter a valid email address.");
      } else if (error?.code === "auth/weak-password") {
        setCreateAccountError("Choose a stronger password and try again.");
      } else {
        setCreateAccountError(
          error?.message || "Unable to create the account. Please try again.",
        );
      }
    } finally {
      setCreatingAccount(false);
    }
  };

  const handleSignOut = async () => {
    setShowProfileMenu(false);
    setShowNotifications(false);

    try {
      await signOutFirebaseUser();
    } catch (error) {
      setAuthError(error?.message || "Sign out failed.");
    }
  };

  const handleClearData = () => {
    if (clearingData) {
      return;
    }

    setClearDataError("");
    setShowClearDataPrompt(true);
  };

  const confirmClearData = async () => {
    try {
      setClearingData(true);
      deviceOnlineRef.current = false;
      lastDeviceSnapshotAtRef.current = 0;
      firebaseConnectedRef.current = false;
      setFirebaseConnected(false);
      readingHistoryRef.current = [];
      telemetryHistoryRef.current = [];
      allHistoryReadingsRef.current = [];
      await clearFirebaseTelemetry();
      setEnergyTotal(0);
      setStepsTotal(0);
      setStepsLastFiveMinutes(0);
      setDemandLevel("NONE");
      setLedRemainingSeconds(0);
      setHasLedTimer(false);
      ledTimerEndsAtRef.current = 0;
      ledReportedSecondsRef.current = null;
      ledStepTimestampRef.current = 0;
      setTrafficRate(0);
      currentFootstepAtRef.current = 0;
      setCurrentFootstep(0);
      setSystemStatus("Offline");
      setLastDeviceUpdate(0);
      setEnergySeries([]);
      setTrafficSeries([]);
      setActivityLog([]);
      setHistoryLog([]);
      setPiezoTrend([]);
      setMpptSeries([]);
      setStepEvents([]);
      setHasReadingHistory(false);
      readingHistoryRef.current = [];
      setPiezoSummary(makePiezoSummary());
      setPiezoAlerts([]);
      setSavedAlerts([]);
      setConnectionNotification(null);
      setSelectedTileId("KineticGen");
      tileMetadataRef.current = { tileId: "KineticGen", zone: "KineticGen" };
      setDismissedNotificationIds(new Set());
      setReadNotificationIds(new Set());
      setShowClearDataPrompt(false);
    } catch (error) {
      setClearDataError(error?.message || "Unable to clear dashboard data.");
    } finally {
      setClearingData(false);
    }
  };

  const handleClearHistory = () => {
    if (clearingHistory) return;
    setClearHistoryError("");
    setShowClearHistoryPrompt(true);
  };

  const confirmClearHistory = async () => {
    try {
      setClearingHistory(true);
      readingHistoryRef.current = [];
      telemetryHistoryRef.current = [];
      await clearFirebaseHistory(Date.now());
      setHistoryLog([]);
      setShowClearHistoryPrompt(false);
    } catch (error) {
      setClearHistoryError(error?.message || "Unable to clear history.");
    } finally {
      setClearingHistory(false);
    }
  };

  const avgCurrent = useMemo(
    () =>
      piezoSummary.tiles.length
        ? piezoSummary.tiles.reduce((total, tile) => total + tile.current, 0) /
          piezoSummary.tiles.length
        : 0,
    [piezoSummary],
  );
  const timestampedStepEvents = stepEvents
    .map((event) => ({
      timestamp: getTimestampMs(event.timestamp),
      count: event.count,
    }))
    .filter((event) => event.timestamp > 0)
    .sort((first, second) => first.timestamp - second.timestamp);
  const recentStepActivations = timestampedStepEvents.slice(-3).reverse();
  let currentStepBatchStart = Math.max(0, timestampedStepEvents.length - 1);
  while (
    currentStepBatchStart > 0 &&
    timestampedStepEvents[currentStepBatchStart].timestamp -
      timestampedStepEvents[currentStepBatchStart - 1].timestamp <=
      CURRENT_STEP_RESET_TIMEOUT_MS
  ) {
    currentStepBatchStart -= 1;
  }
  const persistedCurrentStepBatch = timestampedStepEvents
    .slice(currentStepBatchStart)
    .reduce((total, event) => total + event.count, 0);
  const latestPersistedStepAt =
    timestampedStepEvents[timestampedStepEvents.length - 1]?.timestamp || 0;
  const liveStepTimestamp = currentFootstepAtRef.current;
  const persistedBatchIsCurrent =
    latestPersistedStepAt > 0 &&
    liveStepTimestamp - latestPersistedStepAt <=
      CURRENT_STEP_RESET_TIMEOUT_MS &&
    liveStepTimestamp - latestPersistedStepAt >= -5_000;
  const provisionalLiveSteps =
    currentFootstep > 0
      ? Math.max(
          0,
          currentFootstep -
            (persistedBatchIsCurrent ? persistedCurrentStepBatch : 0),
        )
      : 0;
  const heatmap = Array.from({ length: 24 }, (_, hour) => {
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const count =
      timestampedStepEvents
        .filter((event) => event.timestamp >= startOfToday)
        .filter((event) => new Date(event.timestamp).getHours() === hour)
        .reduce((total, event) => total + event.count, 0) +
      (provisionalLiveSteps > 0 &&
      liveStepTimestamp >= startOfToday &&
      new Date(liveStepTimestamp).getHours() === hour
        ? provisionalLiveSteps
        : 0);

    return {
      hour: `${String(hour).padStart(2, "0")}:00`,
      low: count > 0 && count <= TRAFFIC_LOW_MAX ? count : 0,
      medium:
        count > TRAFFIC_LOW_MAX && count <= TRAFFIC_MEDIUM_MAX ? count : 0,
      high: count > TRAFFIC_MEDIUM_MAX ? count : 0,
    };
  });

  if (authLoading) {
    if (isAndroidApp) {
      return (
        <div
          className="android-auth-loading"
          role="status"
          aria-label="Getting your dashboard ready"
        >
          <div className="auth-ripple" aria-hidden="true">
            <span className="auth-ripple-ring" />
            <span className="auth-ripple-ring" />
            <span className="auth-ripple-ring" />
            <img
              className="auth-loader-logo"
              src="/gemini_generated_this_one.png"
              alt=""
            />
          </div>
          <p className="android-loading-label">
            Getting your dashboard ready
            <span className="android-loading-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </p>
          <p className="android-loading-hint">This will only take a moment</p>
        </div>
      );
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050505] px-6 text-neutral-100">
        <div className="max-w-md rounded-3xl border border-white/[0.1] bg-[#0e0e0e] px-6 py-6 shadow-[0_16px_36px_rgba(0,0,0,0.34)]">
          <p className="text-xs uppercase tracking-[0.35em] text-emerald-400">
            firebase authentication
          </p>
          <p className="mt-3 text-lg font-semibold text-white">
            Loading sign-in state
          </p>
          <p className="mt-2 text-sm text-neutral-400">
            Waiting for Firebase to finish checking your session.
          </p>
        </div>
      </div>
    );
  }

  if (verificationPending && firebaseAuth?.currentUser) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050505] px-4 text-neutral-100">
        <div className="w-full max-w-md rounded-3xl border border-white/[0.1] bg-[#0e0e0e] p-6 text-center shadow-[0_16px_36px_rgba(0,0,0,0.34)]">
          <p className="text-xs uppercase tracking-[0.3em] text-emerald-400">
            email verification
          </p>
          <h1 className="mt-3 text-2xl font-semibold text-white">
            Check your email
          </h1>
          <p className="mt-3 text-sm leading-6 text-neutral-300">
            We sent a verification link to{" "}
            <strong>{firebaseAuth.currentUser.email}</strong>. Open it, verify
            your email, and keep this page open. The dashboard will sign you in
            automatically.
          </p>
          <p className="mt-3 text-sm leading-6 text-amber-200">
            Do not see the email? Please check your Spam or Junk folder.
          </p>
          <p className="mt-4 text-xs text-neutral-500">
            Waiting for verification...
          </p>
          <button
            type="button"
            onClick={() => {
              setVerificationPending(false);
              setAuthNotice("");
              void signOutFirebaseUser();
            }}
            className="mt-6 rounded-xl border border-white/[0.12] px-4 py-2 text-sm font-semibold text-neutral-300 transition hover:bg-white/[0.06]"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  if (currentPath === ACCOUNT_CREATION_PATH && authUser) {
    return (
      <main
        className="flex min-h-[100dvh] flex-col bg-[#050505] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] text-neutral-100 sm:px-6"
      >
        <header className="mx-auto flex w-full max-w-4xl items-center justify-between">
          <div>
            <p className="text-[0.7rem] font-semibold uppercase tracking-[0.25em] text-emerald-400">
              KINETIC-GEN
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigateToPath("/")}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/[0.12] px-3 text-sm font-medium text-neutral-300 transition hover:border-white/25 hover:bg-white/[0.06] hover:text-white"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span className="sm:hidden">Back</span>
            <span className="hidden sm:inline">Back to dashboard</span>
          </button>
        </header>

        <div className="mx-auto flex w-full max-w-4xl flex-1 items-center justify-center py-5">
          <section className="w-full max-w-md rounded-3xl border border-white/[0.1] bg-[#0e0e0e] p-4 shadow-[0_20px_60px_rgba(0,0,0,0.4)] sm:p-6">
            {createdAccountEmail ? (
              <div className="py-3 text-center sm:py-5" aria-live="polite">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
                  <UserCircle size={23} aria-hidden="true" />
                </div>
                <p className="mt-4 text-[0.7rem] font-semibold uppercase tracking-[0.25em] text-emerald-400">
                  Account created
                </p>
                <h1 className="mt-2 text-xl font-semibold text-white sm:text-2xl">
                  Verify the new email
                </h1>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-5 text-neutral-400">
                  We sent a verification link to{" "}
                  <strong className="break-all text-neutral-200">
                    {createdAccountEmail}
                  </strong>
                  . The new user must verify their email before signing in.
                </p>
                <p className="mt-2 text-xs text-neutral-500">
                  If the email does not arrive, check the Spam or Junk folder.
                </p>
                <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-center">
                  <button
                    type="button"
                    onClick={() => setCreatedAccountEmail("")}
                    className="min-h-11 rounded-xl border border-white/[0.12] px-4 text-sm font-semibold text-neutral-300 transition hover:bg-white/[0.06]"
                  >
                    Create another account
                  </button>
                  <button
                    type="button"
                    onClick={() => navigateToPath("/")}
                    className="min-h-11 rounded-xl bg-emerald-400 px-4 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300"
                  >
                    Return to dashboard
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-[0.7rem] font-semibold uppercase tracking-[0.25em] text-emerald-400">
                  New user
                </p>
                <h1 className="mt-2 text-xl font-semibold text-white sm:text-2xl">
                  Create an account
                </h1>
                <p className="mt-1.5 text-sm leading-5 text-neutral-400">
                  Enter the new user’s email and set a password. We’ll send an
                  email verification link before they can sign in.
                </p>

                <form
                  onSubmit={handleCreateAccount}
                  autoComplete="on"
                  className="mt-5 space-y-4"
                >
                  <label className="block text-sm font-medium text-neutral-300">
                    Email address
                    <input
                      value={newAccountEmail}
                      onChange={(event) => setNewAccountEmail(event.target.value)}
                      type="email"
                      name="new-account-email"
                      autoComplete="email"
                      autoCapitalize="none"
                      spellCheck="false"
                      required
                      disabled={creatingAccount}
                      className="mt-1.5 min-h-11 w-full rounded-xl border border-white/[0.12] bg-[#050505] px-3.5 text-base text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-emerald-400 disabled:opacity-60"
                      placeholder="name@example.com"
                    />
                  </label>

                  <label className="block text-sm font-medium text-neutral-300">
                    Password
                    <div className="relative mt-1.5">
                      <input
                        value={newAccountPassword}
                        onChange={(event) =>
                          setNewAccountPassword(event.target.value)
                        }
                        type={showPassword ? "text" : "password"}
                        name="new-account-password"
                        autoComplete="new-password"
                        minLength={6}
                        required
                        disabled={creatingAccount}
                        className="min-h-11 w-full rounded-xl border border-white/[0.12] bg-[#050505] px-3.5 pr-12 text-base text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-emerald-400 disabled:opacity-60"
                        placeholder="At least 6 characters"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((current) => !current)}
                        aria-label={
                          showPassword ? "Hide password" : "Show password"
                        }
                        className="absolute inset-y-0 right-3 flex min-w-8 items-center justify-center text-neutral-400 hover:text-neutral-200"
                      >
                        {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                  </label>

                  <label className="block text-sm font-medium text-neutral-300">
                    Confirm password
                    <div className="relative mt-1.5">
                      <input
                        value={newAccountConfirmPassword}
                        onChange={(event) =>
                          setNewAccountConfirmPassword(event.target.value)
                        }
                        type={showConfirmPassword ? "text" : "password"}
                        name="new-account-confirm-password"
                        autoComplete="new-password"
                        minLength={6}
                        required
                        disabled={creatingAccount}
                        className="min-h-11 w-full rounded-xl border border-white/[0.12] bg-[#050505] px-3.5 pr-12 text-base text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-emerald-400 disabled:opacity-60"
                        placeholder="Re-enter password"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setShowConfirmPassword((current) => !current)
                        }
                        aria-label={
                          showConfirmPassword
                            ? "Hide confirmed password"
                            : "Show confirmed password"
                        }
                        className="absolute inset-y-0 right-3 flex min-w-8 items-center justify-center text-neutral-400 hover:text-neutral-200"
                      >
                        {showConfirmPassword ? (
                          <EyeOff size={18} />
                        ) : (
                          <Eye size={18} />
                        )}
                      </button>
                    </div>
                  </label>

                  {createAccountError && (
                    <p
                      role="alert"
                      className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm leading-5 text-rose-200"
                    >
                      {createAccountError}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={creatingAccount}
                    className="min-h-11 w-full rounded-xl bg-emerald-400 px-4 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {creatingAccount ? "Creating account..." : "Create account"}
                  </button>
                </form>
              </>
            )}
          </section>
        </div>
      </main>
    );
  }

  if (!authUser) {
    return (
      <div
        className={`auth-page min-h-[100dvh] text-neutral-100 ${isAndroidApp ? "android-auth-page" : ""}`}
        data-theme={isDark ? "dark" : "light"}
      >
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={`Switch to ${isDark ? "day" : "night"} mode`}
          title={`Switch to ${isDark ? "day" : "night"} mode`}
          className="auth-theme-toggle"
        >
          <span className="auth-theme-toggle-icon" aria-hidden="true">
            {isDark ? <Sun size={17} /> : <Moon size={17} />}
          </span>
          <span>{isDark ? "Day" : "Night"}</span>
        </button>
        <div
          className={`auth-layout mx-auto flex min-h-[100dvh] w-full max-w-5xl items-center justify-center px-4 py-8 ${isAndroidApp ? "android-auth-layout" : ""}`}
        >
          <section className="auth-intro-panel">
            <p className="text-xs uppercase tracking-[0.35em] text-emerald-400">
              Monitoring System
            </p>
            <h1 className="mt-3 text-4xl font-semibold text-white sm:text-5xl">
              KINETIC-GEN
            </h1>
            <p className="mt-4 max-w-md text-sm leading-6 text-neutral-400 sm:text-base">
              Monitor piezoelectric tile performance and energy activity in real
              time.
            </p>
            <svg
              className="auth-curve"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path
                className="auth-curve-path auth-curve-path-desktop"
                d="M 8 0 C 74 25, 74 75, 8 100"
              />
              <path
                className="auth-curve-path auth-curve-path-mobile"
                d="M 0 8 C 25 74, 75 74, 100 8"
              />
            </svg>
          </section>
          <form
            onSubmit={handleAuthSubmit}
            autoComplete="off"
            className="auth-form-panel w-full rounded-3xl border border-white/[0.1] bg-[#0e0e0e] p-6 shadow-[0_16px_36px_rgba(0,0,0,0.34)]"
          >
            <h2
              className={`${isAndroidApp ? "mt-0" : "mt-8"} text-xl font-semibold text-white`}
            >
              {authMode === "create"
                ? "Create your account"
                : authMode === "reset"
                  ? "Reset your password"
                  : "Sign in to the dashboard"}
            </h2>
            <p className="mt-2 text-sm text-neutral-400">
              {authMode === "create"
                ? "Choose an email and password for this dashboard."
                : authMode === "reset"
                  ? "Enter your email and we will send you a secure password reset link."
                  : "Enter the email and password provided to you."}
            </p>

            <label className="mt-5 block text-sm text-neutral-300">
              Email address
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                name="dashboard-email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck="false"
                disabled={authSubmitting}
                className="mt-2 w-full rounded-xl border border-white/[0.12] bg-[#050505] px-4 py-3 text-neutral-100 outline-none ring-0 focus:border-emerald-400"
                placeholder="name@example.com"
              />
            </label>

            {authMode !== "reset" && (
              <label className="mt-4 block text-sm text-neutral-300">
                Password
                <div className="relative mt-2">
                  <input
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type={showPassword ? "text" : "password"}
                    name="dashboard-password"
                    autoComplete="new-password"
                    disabled={authSubmitting}
                    className="w-full rounded-xl border border-white/[0.12] bg-[#050505] px-4 py-3 pr-11 text-neutral-100 outline-none ring-0 focus:border-emerald-400"
                    placeholder="Enter password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((current) => !current)}
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    className="absolute inset-y-0 right-3 flex items-center text-neutral-400 transition hover:text-neutral-200"
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </label>
            )}

            {authMode === "create" && (
              <label className="mt-4 block text-sm text-neutral-300">
                Confirm password
                <div className="relative mt-2">
                  <input
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    type={showConfirmPassword ? "text" : "password"}
                    name="dashboard-confirm-password"
                    autoComplete="new-password"
                    disabled={authSubmitting}
                    className="w-full rounded-xl border border-white/[0.12] bg-[#050505] px-4 py-3 pr-11 text-neutral-100 outline-none ring-0 focus:border-emerald-400"
                    placeholder="Re-enter password"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setShowConfirmPassword((current) => !current)
                    }
                    aria-label={
                      showConfirmPassword
                        ? "Hide confirmed password"
                        : "Show confirmed password"
                    }
                    className="absolute inset-y-0 right-3 flex items-center text-neutral-400 transition hover:text-neutral-200"
                  >
                    {showConfirmPassword ? (
                      <EyeOff size={18} />
                    ) : (
                      <Eye size={18} />
                    )}
                  </button>
                </div>
              </label>
            )}

            {authError && (
              <p className="auth-error-message mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {authError}
              </p>
            )}

            {authNotice && (
              <p className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                {authNotice}
              </p>
            )}

            <button
              type="submit"
              disabled={authSubmitting}
              className="mt-5 w-full rounded-xl bg-emerald-400 px-4 py-3 font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-emerald-400/60"
            >
              {authSubmitting
                ? "Working..."
                : authMode === "reset"
                  ? "Send reset email"
                  : authMode === "create"
                    ? "Create Firebase account"
                    : "Sign in"}
            </button>

            {authMode === "signin" && (
              <button
                type="button"
                disabled={authSubmitting}
                onClick={() => {
                  setAuthError("");
                  setAuthNotice("");
                  setAuthMode("reset");
                }}
                className="mt-4 w-full text-center text-xs font-semibold text-emerald-300 transition hover:text-emerald-200 disabled:cursor-not-allowed"
              >
                Forgot password?
              </button>
            )}

            {authMode === "reset" ? (
              <button
                type="button"
                disabled={authSubmitting}
                onClick={() => setAuthMode("signin")}
                className="mt-4 w-full text-center text-xs font-semibold text-slate-400 transition hover:text-slate-200 disabled:cursor-not-allowed"
              >
                Back to sign in
              </button>
            ) : (
              <p className="mt-4 text-center text-xs leading-5 text-slate-500">
                Use the credentials provided for this private monitoring
                dashboard.
              </p>
            )}
          </form>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`dashboard-shell ${isAndroidApp ? "android-app" : ""} min-h-[100dvh] transition-colors duration-150 ${
        isDark ? "bg-[#050505]" : isAndroidApp ? "bg-slate-100" : "bg-slate-200"
      } ${isDark ? "text-neutral-100" : "text-slate-900"}`}
      data-theme={isDark ? "dark" : "light"}
    >
      <div className="dashboard-frame flex min-h-0 w-full flex-col gap-3 px-2 py-3 sm:gap-4 sm:px-3 sm:py-4">
        <header
          className={`dashboard-header relative z-50 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 ${headerClass}`}
        >
          {!isAndroidApp && (
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-emerald-400">
                KINETIC-GEN
              </p>
              <h1 className={`text-lg font-semibold sm:text-2xl ${strongText}`}>
                Piezoelectric Energy Tile Dashboard
              </h1>
            </div>
          )}
          <div className="mobile-header-actions flex w-full min-w-0 flex-nowrap items-center justify-start gap-2 sm:w-auto sm:justify-end sm:gap-3">
            <div
              className={`flex flex-shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold shadow-sm ${
                isDark
                  ? "border-white/[0.12] bg-[#151515]"
                  : "border-slate-300 bg-slate-50"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  displayedSystemStatus === "Online"
                    ? "bg-emerald-400"
                    : displayedSystemStatus === "Loading"
                      ? "animate-pulse bg-amber-300"
                      : "bg-rose-400"
                }`}
              />
              <span
                className={
                  displayedSystemStatus === "Online"
                    ? isDark
                      ? "text-emerald-300"
                      : "text-emerald-700"
                    : displayedSystemStatus === "Loading"
                      ? isDark
                        ? "text-amber-300"
                        : "text-amber-700"
                      : isDark
                        ? "text-rose-400"
                        : "text-rose-600"
                }
              >
                {displayedSystemStatus}
              </span>
              <span className="opacity-40">|</span>
              <span
                className={
                  ldrStatus === "Unavailable"
                    ? isDark
                      ? "text-slate-500"
                      : "text-slate-400"
                    : ldrStatus === "Night"
                      ? isDark
                        ? "text-indigo-300"
                        : "text-indigo-600"
                      : isDark
                        ? "text-amber-300"
                        : "text-yellow-500"
                }
              >
                {ldrStatus === "Night" ? (
                  <Moon size={14} />
                ) : ldrStatus === "Unavailable" ? (
                  <Wifi size={14} />
                ) : (
                  <Sun size={14} />
                )}
              </span>
              <span
                className={
                  ldrStatus === "Unavailable"
                    ? isDark
                      ? "text-slate-500"
                      : "text-slate-400"
                    : ldrStatus === "Night"
                      ? isDark
                        ? "text-indigo-300"
                        : "text-indigo-600"
                      : isDark
                        ? "text-amber-300"
                        : "text-yellow-500"
                }
              >
                {ldrStatus}
              </span>
            </div>
            {databaseError && (
              <span
                className="dashboard-database-error max-w-xs truncate text-xs text-rose-300"
                title={databaseError}
              >
                Firebase: {databaseError}
              </span>
            )}
            <div className="header-personal-actions ml-auto flex flex-shrink-0 items-center gap-2 sm:ml-0">
              <div className="relative flex-shrink-0">
                <button
                  type="button"
                  onClick={toggleTheme}
                  aria-label={
                    isDark ? "Switch to light mode" : "Switch to dark mode"
                  }
                  title={
                    isDark ? "Switch to light mode" : "Switch to dark mode"
                  }
                  className={`${isAndroidApp ? "theme-toggle-button flex h-9 w-9 items-center justify-center" : ""} rounded-full border p-2 transition ${chipBase}`}
                >
                  {isDark ? <Moon size={18} /> : <Sun size={18} />}
                </button>
              </div>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setShowProfileMenu((current) => !current);
                    setShowNotifications(false);
                  }}
                  aria-label="Open profile menu"
                  className={`${isAndroidApp ? "profile-menu-button flex h-9 w-9 items-center justify-center" : ""} rounded-full border p-2 transition ${chipBase}`}
                >
                  <UserCircle size={18} />
                </button>
                {showProfileMenu && (
                  <div
                    className={`absolute right-0 top-14 z-[60] max-h-[min(70vh,32rem)] w-[min(14rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border p-2 shadow-2xl sm:top-11 ${
                      isDark
                        ? "border-white/[0.1] bg-[#101010]"
                        : "border-slate-300 bg-slate-50"
                    }`}
                  >
                    <p className={`truncate px-3 py-2 text-xs ${subtleText}`}>
                      {authUser.email}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setShowProfileMenu(false);
                        setNewAccountEmail("");
                        setNewAccountPassword("");
                        setNewAccountConfirmPassword("");
                        setCreateAccountError("");
                        setCreatedAccountEmail("");
                        setShowPassword(false);
                        setShowConfirmPassword(false);
                        navigateToPath(ACCOUNT_CREATION_PATH);
                      }}
                      className={`w-full rounded-lg px-3 py-2 text-left text-sm font-semibold transition ${
                        isDark
                          ? "text-emerald-300 hover:bg-white/[0.06]"
                          : "text-emerald-700 hover:bg-slate-100"
                      }`}
                    >
                      Create account
                    </button>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-rose-500 transition hover:bg-rose-500/10"
                    >
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        <div className="dashboard-body flex min-w-0 flex-col items-stretch gap-3 sm:gap-4 lg:flex-row">
          {/* Left Sidebar Navigation */}
          <aside
            className={`dashboard-nav flex w-full flex-col gap-3 rounded-2xl border p-2 backdrop-blur sm:p-4 lg:w-56 lg:flex-shrink-0 lg:pb-6 ${
              isDark
                ? "border-white/[0.08] bg-[#090909]"
                : "border-slate-400 bg-slate-100 shadow-lg shadow-slate-400/30"
            } lg:min-h-[calc(100vh-8rem)]`}
          >
            <p
              className={`mb-1 px-2 text-[10px] font-semibold uppercase tracking-[0.15em] sm:mb-2 sm:text-xs sm:tracking-[0.2em] ${mutedText}`}
            >
              Navigation
            </p>
            <div className="mobile-nav-scroll flex min-w-0 gap-3 overflow-x-auto overflow-y-visible lg:flex-1 lg:flex-col">
              {[
                { id: "overview", label: "Overview" },
                { id: "piezo", label: "Piezo Tile" },
                { id: "mppt", label: "P&O Trace" },
                { id: "history", label: "History" },
                { id: "guide", label: "User Manual" },
              ].map((item) => (
                <button
                  key={item.id}
                  onClick={() => navigateToSection(item.id)}
                  aria-label={item.label}
                  aria-current={activeSection === item.id ? "page" : undefined}
                  title={item.label}
                  className={`flex flex-shrink-0 items-center gap-3 rounded-lg border px-3 py-2 text-left text-xs font-semibold transition sm:px-4 sm:py-3 sm:text-sm lg:w-full ${
                    activeSection === item.id
                      ? isDark
                        ? "border-emerald-400/50 bg-emerald-400/15 text-emerald-200"
                        : "border-emerald-600 bg-emerald-100 text-emerald-800 shadow-md shadow-emerald-900/15"
                      : isDark
                        ? "border-white/[0.1] text-neutral-300 hover:border-white/[0.18] hover:bg-white/[0.05]"
                        : "border-slate-400 bg-slate-100 text-slate-700 shadow-sm hover:border-slate-500 hover:bg-slate-200 hover:shadow-md"
                  }`}
                >
                  {item.id === "overview" && <BarChart3 size={18} />}
                  {item.id === "piezo" && <Zap size={18} />}
                  {item.id === "mppt" && <Activity size={18} />}
                  {item.id === "history" && <Clock size={18} />}
                  {item.id === "guide" && <Lightbulb size={18} />}
                  <span className="dashboard-nav-label">{item.label}</span>
                </button>
              ))}
            </div>
          </aside>

          {/* Main Content Area */}
          <main
            className="dashboard-main flex min-w-0 flex-1 flex-col gap-4 sm:gap-6"
            onTouchStart={isAndroidApp ? handleDashboardTouchStart : undefined}
            onTouchMove={isAndroidApp ? handleDashboardTouchMove : undefined}
            onTouchEnd={isAndroidApp ? handleDashboardTouchEnd : undefined}
            onTouchCancel={
              isAndroidApp
                ? () => {
                    dashboardTouchStartRef.current = null;
                  }
                : undefined
            }
          >
            {activeSection === "overview" && (
              <div className="dashboard-overview fade-in flex flex-col gap-4">
                {isAndroidApp && (
                  <h1
                    className={`text-center text-xl font-semibold ${strongText}`}
                  >
                    Overview
                  </h1>
                )}
                <section
                  className={`dashboard-metrics grid ${isAndroidApp ? "gap-4" : "gap-3"} md:grid-cols-2 xl:grid-cols-4`}
                >
                  <div
                    {...getOverviewDragProps(
                      "metric",
                      "energy",
                      overviewMetricOrder,
                    )}
                    className={`${cardClass} dashboard-metric-card ${getOverviewDragClassName("metric", "energy")}`}
                  >
                    <div className="flex items-center justify-between">
                      <p
                        className={`dashboard-metric-label text-sm ${mutedText}`}
                      >
                        Harvested Energy
                      </p>
                      <BatteryCharging
                        className={
                          isDark ? "text-emerald-300" : "text-emerald-500"
                        }
                        size={18}
                      />
                    </div>
                    <div className="dashboard-energy-summary mt-3 flex items-end gap-3">
                      <div>
                        <p
                          className={`dashboard-metric-value text-2xl font-semibold ${strongText}`}
                        >
                          {formatEnergy(energyTotal)}
                        </p>
                        <p
                          className={`dashboard-metric-caption text-xs ${isDark ? "text-emerald-300" : "text-emerald-600"}`}
                        >
                          Total energy generated
                        </p>
                      </div>
                      <div className="dashboard-sparkline ml-auto h-12 w-24">
                        <Suspense fallback={null}>
                          <Charts
                            type="sparkline"
                            data={sparkline}
                            isDark={isDark}
                          />
                        </Suspense>
                      </div>
                    </div>
                  </div>

                  <div
                    {...getOverviewDragProps(
                      "metric",
                      "steps",
                      overviewMetricOrder,
                    )}
                    className={`${cardClass} dashboard-metric-card ${getOverviewDragClassName("metric", "steps")}`}
                  >
                    <div className="flex items-center justify-between">
                      <p
                        className={`dashboard-metric-label text-sm ${mutedText}`}
                      >
                        Total Steps Today
                      </p>
                      <Footprints
                        className={
                          isDark ? "text-emerald-300" : "text-emerald-500"
                        }
                        size={18}
                      />
                    </div>
                    <p
                      className={`dashboard-metric-value mt-3 text-2xl font-semibold ${strongText}`}
                    >
                      {stepsTotal.toLocaleString()}
                    </p>
                    <p
                      className={`dashboard-metric-caption text-xs ${subtleText}`}
                    >
                      Live counter from tiles
                    </p>
                  </div>

                  <div
                    {...getOverviewDragProps(
                      "metric",
                      "mode",
                      overviewMetricOrder,
                    )}
                    className={`${cardClass} dashboard-metric-card ${getOverviewDragClassName("metric", "mode")}`}
                  >
                    <div className="flex items-center justify-between">
                      <p
                        className={`dashboard-metric-label text-sm ${mutedText}`}
                      >
                        System Mode
                      </p>
                      <Activity
                        className={
                          isDark ? "text-emerald-300" : "text-emerald-500"
                        }
                        size={18}
                      />
                    </div>
                    <p
                      className={`dashboard-metric-value dashboard-mode-value mt-3 text-2xl font-semibold ${strongText}`}
                    >
                      {systemMode}
                    </p>
                    <p
                      className={`dashboard-metric-caption text-xs ${subtleText}`}
                    >
                      Adaptive lighting based on daylight
                    </p>
                    <p
                      className={`dashboard-metric-caption mt-1 text-xs ${subtleText}`}
                    >
                      {demandLevel} demand · {stepsLastFiveMinutes} steps in 5
                      min
                    </p>
                    <p
                      className={`dashboard-metric-caption mt-1 flex items-center gap-1.5 text-xs ${subtleText}`}
                    >
                      LED Light:
                      <span
                        className={`font-semibold ${
                          ledLightStatus === "ON"
                            ? "text-emerald-400"
                            : ledLightStatus === "OFF"
                              ? "text-neutral-400"
                              : "text-amber-400"
                        }`}
                      >
                        {ledLightStatus}
                      </span>
                    </p>
                    <p
                      className={`dashboard-metric-caption mt-1 text-xs ${subtleText}`}
                    >
                      {ledLightStatus === "Unavailable"
                        ? "LED timer unavailable"
                        : ledRemainingSeconds >= 60
                          ? `LED timer: ${Math.ceil(ledRemainingSeconds / 60)} min left`
                          : `LED timer: ${ledRemainingSeconds}s left`}
                    </p>
                  </div>

                  <div
                    {...getOverviewDragProps(
                      "metric",
                      "currentStep",
                      overviewMetricOrder,
                    )}
                    className={`${cardClass} dashboard-metric-card ${getOverviewDragClassName("metric", "currentStep")}`}
                  >
                    <div className="flex items-center justify-between">
                      <p
                        className={`dashboard-metric-label text-sm ${mutedText}`}
                      >
                        Current Footstep
                      </p>
                      <ArrowUpRight
                        className={
                          isDark ? "text-emerald-300" : "text-emerald-600"
                        }
                        size={18}
                      />
                    </div>
                    <p
                      className={`dashboard-metric-value mt-3 text-2xl font-semibold ${strongText}`}
                    >
                      {currentFootstep.toLocaleString()}
                    </p>
                    <p
                      className={`dashboard-metric-caption text-xs ${subtleText}`}
                    >
                      Latest step event
                    </p>
                  </div>
                </section>

                <section
                  className={`dashboard-charts grid items-stretch ${isAndroidApp ? "gap-4" : "gap-3"} xl:min-h-[calc(100vh-18rem)] xl:grid-cols-[2fr_1fr]`}
                >
                  <div
                    {...getOverviewDragProps(
                      "chart",
                      "energyTrend",
                      overviewChartOrder,
                    )}
                    className={`${cardClass} dashboard-chart-panel overview-chart-panel flex h-full min-h-0 flex-col ${getOverviewDragClassName("chart", "energyTrend")}`}
                  >
                    <div className="mb-4 flex items-center justify-between">
                      <div>
                        <h2 className={`text-base font-semibold ${strongText}`}>
                          Energy Harvested by Hour
                        </h2>
                        <p className={`text-xs ${subtleText}`}>
                          Generated energy per hour, last 24 hours
                        </p>
                      </div>
                    </div>
                    <div
                      className="dashboard-chart-container min-h-64 flex-1"
                      data-no-tab-swipe
                    >
                      {!hasReadingHistory ? (
                        <div
                          className={`flex h-full flex-col items-center justify-center gap-1 px-4 text-center ${subtleText}`}
                        >
                          <p className={`text-sm font-medium ${mutedText}`}>
                            No energy readings yet
                          </p>
                          <p className="max-w-xs text-xs leading-5">
                            Energy history will show here once your tile sends
                            data.
                          </p>
                        </div>
                      ) : (
                        <Suspense fallback={null}>
                          <Charts type="energy" data={piezoTrend} />
                        </Suspense>
                      )}
                    </div>
                  </div>

                  <div
                    {...getOverviewDragProps(
                      "chart",
                      "heatmap",
                      overviewChartOrder,
                    )}
                    className={`${cardClass} dashboard-chart-panel overview-chart-panel flex h-full min-h-0 flex-col ${getOverviewDragClassName("chart", "heatmap")}`}
                  >
                    <div className="mb-4 flex items-center justify-between">
                      <div>
                        <h2 className={`text-base font-semibold ${strongText}`}>
                          Foot Traffic Heatmap
                        </h2>
                        <p className={`text-xs ${subtleText}`}>00:00 - 23:00</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {trafficLegend.map((item) => (
                          <button
                            key={item.id}
                            onClick={() =>
                              setTrafficCategory((previous) =>
                                previous === item.id ? "all" : item.id,
                              )
                            }
                            className={`rounded-full border px-2 py-1 text-xs font-semibold transition ${
                              trafficCategory === "all" ||
                              trafficCategory === item.id
                                ? `${chipBase} border-emerald-400/50`
                                : chipBase
                            }`}
                          >
                            <span
                              className="mr-1.5 inline-block h-2 w-2 rounded-full"
                              style={{ backgroundColor: item.color }}
                            />
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div
                      className="dashboard-chart-container min-h-64 flex-1"
                      data-no-tab-swipe
                    >
                      <Suspense fallback={null}>
                        <Charts
                          type="traffic"
                          data={heatmap}
                          trafficCategory={trafficCategory}
                        />
                      </Suspense>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {activeSection === "piezo" && (
              <div className="fade-in flex flex-col gap-4">
                {isAndroidApp && (
                  <h1
                    className={`text-center text-xl font-semibold ${strongText}`}
                  >
                    Piezo Tile
                  </h1>
                )}
                <div className="piezo-timestamp-row flex justify-start">
                  <p
                    className={`inline-flex rounded-full border ${isAndroidApp ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"} font-semibold tabular-nums ${chipBase}`}
                  >
                    {currentDateTime.toLocaleString("en-US", {
                      month: "2-digit",
                      day: "2-digit",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: true,
                    })}
                  </p>
                </div>
                <div
                  className={`piezo-metric-grid grid items-stretch gap-3 md:grid-cols-2 ${isAndroidApp ? "xl:grid-cols-3" : "xl:grid-cols-[1fr_2fr] xl:grid-rows-2"}`}
                >
                  <MetricCard
                    title="Voltage"
                    icon={Lightbulb}
                    value={piezoSummary.totalVoltage.toFixed(3)}
                    unit="Volts (V)"
                    cardClass={cardClass}
                    mutedText={mutedText}
                    subtleText={subtleText}
                    strongText={strongText}
                    iconClassName={
                      isDark ? "text-emerald-300" : "text-emerald-600"
                    }
                    iconBackgroundClassName={
                      isDark ? "bg-emerald-400/10" : "bg-emerald-50"
                    }
                    contentClassName="flex flex-1 flex-col justify-center text-center"
                    contentMarginClassName={isAndroidApp ? "mt-0" : "mt-5"}
                    showIcon={!isAndroidApp}
                    className={`flex h-full flex-col justify-between ${isAndroidApp ? "min-h-32 p-3 xl:min-h-56" : "min-h-36 p-4 xl:col-start-2 xl:row-start-1 xl:min-h-56"}`}
                    valueClassName={isAndroidApp ? "piezo-metric-value" : ""}
                    dragProps={getOverviewDragProps(
                      "piezo",
                      "voltage",
                      piezoMetricOrder,
                    )}
                    dragClassName={getOverviewDragClassName("piezo", "voltage")}
                  />
                  <MetricCard
                    title="Current"
                    icon={Gauge}
                    value={(avgCurrent * 1000).toFixed(3)}
                    unit="Current (mA)"
                    cardClass={cardClass}
                    mutedText={mutedText}
                    subtleText={subtleText}
                    strongText={strongText}
                    iconClassName={
                      isDark ? "text-emerald-300" : "text-emerald-600"
                    }
                    iconBackgroundClassName={
                      isDark ? "bg-emerald-400/10" : "bg-emerald-50"
                    }
                    contentClassName="flex flex-1 flex-col justify-center text-center"
                    contentMarginClassName={isAndroidApp ? "mt-0" : "mt-5"}
                    showIcon={!isAndroidApp}
                    className={`flex h-full flex-col justify-between ${isAndroidApp ? "min-h-32 p-3 xl:min-h-56" : "min-h-36 p-4 xl:col-start-2 xl:row-start-2 xl:min-h-56"}`}
                    valueClassName={isAndroidApp ? "piezo-metric-value" : ""}
                    dragProps={getOverviewDragProps(
                      "piezo",
                      "current",
                      piezoMetricOrder,
                    )}
                    dragClassName={getOverviewDragClassName("piezo", "current")}
                  />
                  <MetricCard
                    title="Power"
                    icon={Zap}
                    cardClass={cardClass}
                    mutedText={mutedText}
                    subtleText={subtleText}
                    strongText={strongText}
                    showIcon={!isAndroidApp}
                    iconClassName={
                      isDark ? "text-emerald-300" : "text-emerald-600"
                    }
                    iconBackgroundClassName={
                      isDark ? "bg-emerald-400/10" : "bg-emerald-50"
                    }
                    className={`flex h-full flex-col justify-between ${isAndroidApp ? "min-h-32 p-3 md:col-span-2 xl:col-span-1 xl:min-h-56" : "min-h-56 p-4 md:col-span-2 xl:col-span-1 xl:col-start-1 xl:row-span-2 xl:row-start-1 xl:min-h-[24rem]"}`}
                    dragProps={getOverviewDragProps(
                      "piezo",
                      "power",
                      piezoMetricOrder,
                    )}
                    dragClassName={getOverviewDragClassName("piezo", "power")}
                  >
                    <div
                      className={`${isAndroidApp ? "mt-0" : "mt-4"} flex flex-1 flex-col items-center justify-center gap-5`}
                    >
                      <div className="min-w-0 text-center">
                        <p
                          className={`${isAndroidApp ? "piezo-metric-value text-2xl sm:text-3xl" : "text-3xl sm:text-4xl"} font-bold tracking-tight ${strongText}`}
                        >
                          {formatPower(piezoSummary.totalPower)}
                        </p>
                        <p className={`mt-2 text-xs ${subtleText}`}>
                          Voltage x Current
                        </p>
                      </div>
                    </div>
                  </MetricCard>
                </div>
                <section className={`${cardClass} piezo-activation-preview`}>
                  <div className="mb-2 flex items-center gap-2">
                    <Footprints
                      size={17}
                      className={
                        isDark ? "text-emerald-300" : "text-emerald-600"
                      }
                      aria-hidden="true"
                    />
                    <h3 className={`text-sm font-semibold ${strongText}`}>
                      Recent Tile Activations
                    </h3>
                  </div>
                  <p className={`mb-2 text-xs ${subtleText}`}>
                    Latest step events reported by the ESP32
                  </p>
                  {recentStepActivations.length === 0 ? (
                    <p className={`py-2 text-sm ${subtleText}`}>
                      Step events will appear here when your tile reports
                      them.
                    </p>
                  ) : (
                    <div
                      className={`grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0 ${isDark ? "divide-white/10" : "divide-slate-200"}`}
                    >
                      {recentStepActivations.map((event, index) => (
                        <div
                          key={`${event.timestamp}-${index}`}
                          className="flex min-w-0 flex-col gap-1 py-2 sm:px-3"
                        >
                          <span className={`text-xs ${subtleText}`}>
                            {new Date(event.timestamp).toLocaleString([], {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              hour12: true,
                              minute: "2-digit",
                            })}
                          </span>
                          <span
                            className={`text-sm font-semibold ${strongText}`}
                          >
                            {event.count} {event.count === 1 ? "step" : "steps"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {activeSection === "mppt" && (
              <div className="fade-in flex flex-col gap-6">
                <section className={isAndroidApp ? "" : cardClass}>
                  <div
                    className={`mb-5 ${
                      isAndroidApp
                        ? "text-center"
                        : "flex flex-wrap items-start justify-between gap-3"
                    }`}
                  >
                    <div className={isAndroidApp ? "w-full" : ""}>
                      <h2
                        className={`${
                          isAndroidApp ? "text-center " : ""
                        }text-xl font-semibold ${strongText}`}
                      >
                        P&O Algorithm Trace
                      </h2>
                      <p
                        className={`${
                          isAndroidApp ? "mx-auto " : ""
                        }mt-1 max-w-2xl text-sm ${subtleText}`}
                      >
                        This chart shows how the ESP32 changes the reference
                        voltage to find the setting that produces the most
                        power. It displays reported readings and does not
                        control a converter or charging output.
                      </p>
                    </div>
                    {mpptSeries.length > 0 && (
                      <span
                        className={`${
                          isAndroidApp ? "mt-3 inline-block " : ""
                        }rounded-full border px-3 py-1 text-xs font-semibold ${chipBase}`}
                      >
                        Direction:{" "}
                        {mpptSeries[mpptSeries.length - 1].direction > 0
                          ? "+1 (up)"
                          : mpptSeries[mpptSeries.length - 1].direction < 0
                            ? "-1 (down)"
                            : "Not reported"}
                      </span>
                    )}
                  </div>
                  {mpptSeries.length === 0 ? (
                    <div
                      className={`flex min-h-72 flex-col items-center justify-center gap-1 px-4 text-center ${subtleText}`}
                    >
                      <p className={`text-sm font-medium ${mutedText}`}>
                        Waiting for P&O readings
                      </p>
                      <p className="max-w-md text-xs leading-5">
                        The chart and step table will fill in when your ESP32
                        reports its optimization data.
                      </p>
                    </div>
                  ) : (
                    <div className="h-80" data-no-tab-swipe>
                      <Suspense fallback={null}>
                        <Charts type="mppt" data={mpptSeries} />
                      </Suspense>
                    </div>
                  )}
                </section>
                <section className={cardClass}>
                  <div className="mb-4">
                    <h3 className={`text-base font-semibold ${strongText}`}>
                      Recent P&O Steps
                    </h3>
                    <p className={`mt-1 text-xs ${subtleText}`}>
                      These values show what the ESP32 reported for each
                      algorithm step.
                    </p>
                  </div>
                  {isAndroidApp && (
                    <p className={`table-scroll-hint ${subtleText}`}>
                      <ArrowLeftRight
                        size={14}
                        className={
                          isDark ? "text-emerald-300" : "text-emerald-700"
                        }
                        aria-hidden="true"
                      />
                      <span>Swipe left or right to see more</span>
                    </p>
                  )}
                  <div className="overflow-x-auto">
                    <table className="min-w-[760px] w-full whitespace-nowrap text-left text-xs sm:text-sm">
                      <thead
                        className={`text-xs uppercase ${isDark ? "text-neutral-500" : "text-slate-400"}`}
                      >
                        <tr>
                          <th className="pb-2">Time</th>
                          <th className="pb-2">Power</th>
                          <th className="pb-2">Previous Power</th>
                          <th className="pb-2">Vref</th>
                          <th className="pb-2">Step</th>
                          <th className="pb-2">Direction</th>
                          <th className="pb-2">Decision</th>
                        </tr>
                      </thead>
                      <tbody
                        className={
                          isDark ? "text-neutral-200" : "text-slate-700"
                        }
                      >
                        {mpptSeries.length === 0 ? (
                          <tr>
                            <td
                              colSpan="7"
                              className={`py-4 text-center ${subtleText}`}
                            >
                              No P&O steps reported yet
                            </td>
                          </tr>
                        ) : (
                          mpptSeries
                            .slice(-12)
                            .reverse()
                            .map((step, index) => (
                              <tr
                                key={`${step.time}-${index}`}
                                className={
                                  isDark
                                    ? "border-t border-white/[0.08]"
                                    : "border-t border-slate-200"
                                }
                              >
                                <td className="py-3">{step.time}</td>
                                <td className="py-3">
                                  {formatPower(step.power)}
                                </td>
                                <td className="py-3">
                                  {step.previousPower === null
                                    ? "Not reported"
                                    : formatPower(step.previousPower)}
                                </td>
                                <td className="py-3">
                                  {step.vref.toFixed(2)} V
                                </td>
                                <td className="py-3">
                                  {step.stepV === null
                                    ? "Not reported"
                                    : `${step.stepV.toFixed(2)} V`}
                                </td>
                                <td className="py-3">
                                  {step.direction > 0
                                    ? "+1"
                                    : step.direction < 0
                                      ? "-1"
                                      : "Not reported"}
                                </td>
                                <td className="py-3">
                                  {step.decision || "Not reported"}
                                </td>
                              </tr>
                            ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
                <section className={isAndroidApp ? "" : cardClass}>
                  <h3 className={`text-base font-semibold ${strongText}`}>
                    How to read the trace
                  </h3>
                  <div
                    className={`mt-3 grid gap-4 text-sm leading-6 ${subtleText} md:grid-cols-2`}
                  >
                    <p>
                      <strong className={strongText}>Read the lines:</strong>{" "}
                      The orange line shows power, switching between µW and mW
                      based on its magnitude. The blue line shows the reference
                      voltage, or Vref, in volts.
                    </p>
                    <p>
                      <strong className={strongText}>How it searches:</strong>{" "}
                      The system raises or lowers Vref, then checks the power.
                      It keeps moving in the direction that improves power. If
                      power drops, it changes direction.
                    </p>
                    <p>
                      <strong className={strongText}>What looks normal:</strong>{" "}
                      Power usually increases at first. Near the best setting,
                      power may move up and down slightly while the system
                      checks both directions.
                    </p>
                    <p>
                      <strong className={strongText}>
                        Check the step table:
                      </strong>{" "}
                      It shows the values reported by the ESP32. “Not reported”
                      means the device did not send that value. Missing data,
                      zero power, or sudden large jumps may point to a sensor,
                      timing, connection, or telemetry problem.
                    </p>
                  </div>
                </section>
              </div>
            )}

            {activeSection === "history" && (
              <div className="fade-in flex flex-col gap-6">
                <section className={isAndroidApp ? "" : cardClass}>
                  <div
                    className={`mb-4 flex flex-wrap items-center gap-3 ${
                      isAndroidApp ? "justify-center" : "justify-between"
                    }`}
                  >
                    <div className={isAndroidApp ? "w-full text-center" : ""}>
                      <h2
                        className={`${
                          isAndroidApp ? "text-center text-xl" : "text-base"
                        } font-semibold ${strongText}`}
                      >
                        Reading History
                      </h2>
                      <p
                        className={`${isAndroidApp ? "mt-1 " : ""}text-xs ${subtleText}`}
                      >
                        {historyLog.length === 0
                          ? "New readings will appear here as your tile reports them"
                          : `Showing ${historyLog.length} of 12 saved readings`}
                      </p>
                    </div>
                    <div
                      className={`flex flex-wrap gap-2 ${
                        isAndroidApp ? "w-full justify-end" : ""
                      }`}
                    >
                      <button
                        onClick={handleExport}
                        className={`rounded-full border px-4 py-2 text-xs font-semibold shadow ${chipBase}`}
                      >
                        Export to CSV
                      </button>
                      <button
                        onClick={handleClearHistory}
                        disabled={clearingHistory || historyLog.length === 0}
                        className={`rounded-full px-4 py-2 text-xs font-semibold shadow transition disabled:cursor-not-allowed disabled:opacity-50 ${
                          isDark
                            ? "bg-rose-400/10 text-rose-300 hover:bg-rose-400/20"
                            : "bg-rose-100 text-rose-700 hover:bg-rose-200"
                        }`}
                      >
                        {clearingHistory ? "Clearing..." : "Clear History"}
                      </button>
                    </div>
                  </div>
                  {isAndroidApp && (
                    <p className={`table-scroll-hint ${subtleText}`}>
                      <ArrowLeftRight
                        size={14}
                        className={
                          isDark ? "text-emerald-300" : "text-emerald-700"
                        }
                        aria-hidden="true"
                      />
                      <span>Swipe left or right to see more</span>
                    </p>
                  )}
                  <div className="overflow-x-auto">
                    <table className="min-w-[720px] w-full whitespace-nowrap text-left text-xs sm:text-sm">
                      <thead
                        className={`text-xs uppercase ${isDark ? "text-neutral-500" : "text-slate-400"}`}
                      >
                        <tr>
                          <th className="pb-2">Timestamp</th>
                          <th className="pb-2">Location ID</th>
                          <th className="pb-2">Voltage</th>
                          <th className="pb-2">Current</th>
                          <th className="pb-2">Power</th>
                          <th className="pb-2">Energy</th>
                        </tr>
                      </thead>
                      <tbody
                        className={
                          isDark ? "text-neutral-200" : "text-slate-700"
                        }
                      >
                        {historyLog.length === 0 ? (
                          <tr>
                            <td
                              colSpan="6"
                              className={`py-3 text-center ${subtleText}`}
                            >
                              No records to display
                            </td>
                          </tr>
                        ) : (
                          historyLog.map((entry) => (
                            <tr
                              key={entry.id}
                              className={
                                isDark
                                  ? "border-t border-white/[0.08]"
                                  : "border-t border-slate-200"
                              }
                            >
                              <td className="py-3">
                                {formatHistoryTimestamp(entry)}
                              </td>
                              <td className="py-3">
                                {getHistoryLocation(entry)}
                              </td>
                              <td className="py-3">
                                {entry.Voltage_V ?? entry.voltage ?? "-"} V
                              </td>
                              <td className="py-3">
                                {entry.Current_mA ?? entry.current_mA ?? "-"} mA
                              </td>
                              <td className="py-3">
                                {formatPower(entry.Power_mW ?? entry.power_mW)}
                              </td>
                              <td className="py-3">
                                {formatEnergy(entry.energy_mWh)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}

            {activeSection === "guide" && (
              <div className="fade-in flex flex-col gap-6">
                <section className={isAndroidApp ? "space-y-5" : cardClass}>
                  <div className={`mb-5 ${isAndroidApp ? "text-center" : ""}`}>
                    <div>
                      <h2
                        className={`${
                          isAndroidApp ? "text-center text-xl" : "text-base"
                        } font-semibold ${strongText}`}
                      >
                        User Manual & System Guide
                      </h2>
                      <p className={`mt-1 text-xs ${subtleText}`}>
                        {isAndroidApp
                          ? "A quick guide to reading and managing dashboard data"
                          : "Complete guide to using the piezo monitoring web app"}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-5">
                    {[
                      [
                        UserCircle,
                        "1. Sign in",
                        "Enter your dashboard email and password. Tap the eye to show or hide your password. Choose Forgot password? if you need to reset it.",
                      ],
                      [
                        ArrowLeftRight,
                        "2. Open a tab",
                        isAndroidApp
                          ? "Tap a bottom-bar icon to open Overview, Piezo Tile, P&O Trace, History, or User Manual."
                          : "Select Overview, Piezo Tile, P&O Trace, History, or User Manual from the navigation.",
                      ],
                      [
                        Wifi,
                        "3. Check the header",
                        "Online means the ESP32 sent data recently. Offline means no recent data arrived. Day or Night shows the light sensor reading; Unavailable means no reading is available. Tap the sun or moon to change the app theme.",
                      ],
                      [
                        BarChart3,
                        "4. Read Overview",
                        "See total energy, today's steps, and the latest footstep. System Mode shows lighting mode, demand, recent steps, and whether the LED is ON or OFF. LED status is Unavailable when its timer data is missing or the device is offline.",
                      ],
                      [
                        Activity,
                        "5. Read the Energy Trend",
                        "The chart shows energy recorded over the last 24 hours. Clearing History does not erase the chart's readings.",
                      ],
                      [
                        Gauge,
                        "6. Read Piezo Tile",
                        "Voltage is shown in volts (V), current in milliamps (mA), and power is calculated from voltage × current. Values update when the tile sends readings.",
                      ],
                      [
                        Zap,
                        "7. Read the P&O Trace",
                        "The chart shows the ESP32 searching for a voltage setting that produces more power. Orange is power; blue is reference voltage (Vref). It displays readings but does not control a converter or charger.",
                      ],
                      [
                        Footprints,
                        "8. Read the Foot Traffic Heatmap",
                        "Each column shows steps for one hour. Green: 1–49 steps; blue: 50–69; orange: 70 or more. Tap a label to filter by level; tap it again to show all levels.",
                      ],
                      [
                        Clock,
                        "9. Check History",
                        isAndroidApp
                          ? "History shows up to 12 saved readings, including time, location, voltage, current, power, and energy. Swipe the table sideways to see every column."
                          : "History shows up to 12 saved readings, including time, location, voltage, current, power, and energy. On a phone, scroll sideways to see every column.",
                      ],
                      [
                        Download,
                        isAndroidApp
                          ? "10. Export History"
                          : "10. Export or rename",
                        isAndroidApp
                          ? "In History, tap Export to CSV to save the listed readings as a file."
                          : "In History, select Export to CSV to save the listed readings. You can also rename the tile or zone in its details.",
                      ],
                      [
                        Trash2,
                        "11. Clear History or Data",
                        "Clear History removes saved History records; the Energy Trend keeps its readings. Clear Data removes saved dashboard readings and tile data. Both ask you to confirm, and neither deletes your account.",
                      ],
                      [
                        CircleHelp,
                        "12. If readings stop",
                        "Check that the ESP32 has power, Wi-Fi, and secure sensor connections. If the status stays Offline, ask your project administrator to check the device and connection.",
                      ],
                    ].map(([Icon, title, description]) => (
                      <div
                        key={title}
                        className={
                          isAndroidApp
                            ? "guide-entry"
                            : `rounded-xl border p-4 shadow-sm ${isDark ? "border-white/[0.08] bg-[#101010]" : "border-slate-300 bg-slate-200/70 text-slate-700"}`
                        }
                      >
                        <div className="mb-2 flex items-center gap-2">
                          <span
                            className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${
                              isDark
                                ? "bg-emerald-400/10 text-emerald-300"
                                : "bg-emerald-50 text-emerald-700"
                            }`}
                          >
                            <Icon size={16} aria-hidden="true" />
                          </span>
                          <h3 className={`text-sm font-semibold ${strongText}`}>
                            {title}
                          </h3>
                        </div>
                        <p
                          className={`break-words text-sm leading-6 ${isDark ? subtleText : "text-slate-700"}`}
                        >
                          {description}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>

                <section className={cardClass}>
                  <h3 className={`mb-3 text-base font-semibold ${strongText}`}>
                    Quick Summary
                  </h3>
                  <ul
                    className={`space-y-3 break-words text-sm leading-6 ${isDark ? subtleText : "text-slate-700"}`}
                  >
                    <li>
                      • A footstep presses the tile and creates electrical
                      energy.
                    </li>
                    <li>
                      • Voltage and current readings are used to calculate
                      power: voltage × current.
                    </li>
                    <li>• Online and Offline show whether the ESP32 is sending data.</li>
                  </ul>
                </section>

                <section
                  className={`rounded-2xl border p-5 ${
                    isDark
                      ? "border-rose-400/30 bg-rose-500/5"
                      : "border-rose-200 bg-rose-50"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="max-w-2xl">
                      <h3 className={`text-base font-semibold ${strongText}`}>
                        Clear Dashboard Data
                      </h3>
                      <p className={`mt-2 text-sm ${subtleText}`}>
                        {isAndroidApp
                          ? "This permanently deletes saved readings, history, and tile data. Your account will remain."
                          : "This removes all saved telemetry readings, activity records, history, current tile data, and tile labels from Firebase. It resets the dashboard to an empty offline state but does not delete your account. Use this only when you want to start over. A confirmation message will appear before anything is deleted."}
                      </p>
                    </div>
                    <button
                      onClick={handleClearData}
                      disabled={clearingData}
                      className={`flex items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold shadow-none transition disabled:cursor-not-allowed disabled:opacity-60 ${
                        isDark
                          ? "border-rose-400/50 bg-rose-400/10 text-rose-300 hover:bg-rose-400/20"
                          : "border-rose-300 bg-rose-100 text-rose-700 hover:bg-rose-200"
                      }`}
                      title="Erase dashboard telemetry data"
                    >
                      <Trash2 size={14} />
                      {clearingData ? "Clearing..." : "Clear Data"}
                    </button>
                  </div>
                </section>
              </div>
            )}
          </main>
        </div>
        {showClearDataPrompt && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm"
            role="presentation"
            onClick={() => {
              if (!clearingData) {
                setShowClearDataPrompt(false);
              }
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="clear-data-title"
              className={`w-full max-w-xs rounded-xl p-4 shadow-2xl ${
                isDark
                  ? "bg-[#101010] text-neutral-100"
                  : "bg-white text-slate-900"
              }`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-rose-500/15 p-2 text-rose-400">
                  <Trash2 size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 id="clear-data-title" className="text-base font-semibold">
                    Clear dashboard data?
                  </h2>
                  <p className={`mt-1.5 text-[13px] leading-5 ${subtleText}`}>
                    This permanently clears saved readings, history, and tile
                    data. A connected ESP32 may send new readings again.
                  </p>
                </div>
              </div>
              {clearDataError && (
                <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
                  {clearDataError}
                </p>
              )}
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={clearingData}
                  onClick={() => setShowClearDataPrompt(false)}
                  className={`rounded-full px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                    isDark
                      ? "text-neutral-300 hover:bg-white/[0.08]"
                      : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={clearingData}
                  onClick={confirmClearData}
                  className="rounded-full bg-rose-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {clearingData ? "Clearing..." : "Clear Data"}
                </button>
              </div>
            </div>
          </div>
        )}
        {showClearHistoryPrompt && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm"
            role="presentation"
            onClick={() => {
              if (!clearingHistory) setShowClearHistoryPrompt(false);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="clear-history-title"
              className={`w-full max-w-xs rounded-xl p-4 shadow-2xl ${
                isDark
                  ? "bg-[#101010] text-neutral-100"
                  : "bg-white text-slate-900"
              }`}
              onClick={(event) => event.stopPropagation()}
            >
              <h2 id="clear-history-title" className="text-base font-semibold">
                Clear history?
              </h2>
              <p className={`mt-1.5 text-[13px] leading-5 ${subtleText}`}>
                This removes the saved history records from Firebase. Your
                current telemetry will not be deleted.
              </p>
              {clearHistoryError && (
                <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
                  {clearHistoryError}
                </p>
              )}
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={clearingHistory}
                  onClick={() => setShowClearHistoryPrompt(false)}
                  className={`rounded-full px-4 py-2 text-sm font-semibold ${
                    isDark
                      ? "text-neutral-300 hover:bg-white/[0.08]"
                      : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={clearingHistory}
                  onClick={confirmClearHistory}
                  className="rounded-full bg-rose-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {clearingHistory ? "Clearing..." : "Clear History"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
