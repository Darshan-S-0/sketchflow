import { useEffect, useRef, useState, useCallback } from "react";
import {
  Pencil, Eraser, Trash2, Sparkles, Monitor, MousePointer2,
  Camera, CameraOff, RefreshCw, Check, AlertCircle, Play,
  Search, User, Bell, Settings, Heart, Star, Home, Mail,
  Lock, ArrowRight, Eye, Code, Sliders, CheckCircle2
} from "lucide-react";
import "./App.css";

// Resolve the backend URL based on VITE_API_URL, production mode, or hostname
function resolveBackendConfig() {
  const envUrl = (import.meta.env.VITE_API_URL || "").trim();
  let base = envUrl;

  if (!base) {
    const isLocalhost =
      typeof window !== "undefined" &&
      (window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1" ||
        window.location.hostname === "::1");

    // In production or when hosted on a remote domain (e.g. Render), default to the deployed backend.
    // In local development on localhost/127.0.0.1, default to the local FastAPI dev server.
    base = import.meta.env.PROD || !isLocalhost
      ? "https://sketchflow-6d65.onrender.com"
      : "http://127.0.0.1:8000";
  }

  // Strip trailing slashes
  base = base.replace(/\/+$/, "");

  // If the user supplied a full endpoint ending in /analyze, extract base URL
  if (base.endsWith("/analyze")) {
    base = base.slice(0, -"/analyze".length).replace(/\/+$/, "");
  }

  return {
    backendUrl: base,
    apiUrl: `${base}/analyze`,
  };
}

const { backendUrl: BACKEND_URL, apiUrl: API_URL } = resolveBackendConfig();

export default function App() {
  const canvasRef = useRef(null);
  const cameraRef = useRef(null);
  const streamRef = useRef(null);
  const diffCanvasRef = useRef(null);
  const prevFrameDataRef = useRef(null);
  const autoDetectTimerRef = useRef(null);
  const stableDurationRef = useRef(0);
  const drawing = useRef(false);

  // Canvas & tool state
  const [tool, setTool] = useState("draw");
  const [strokeColor, setStrokeColor] = useState("#181818");
  const [lineWidth, setLineWidth] = useState(3);

  // Camera & stability state
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [capturedImage, setCapturedImage] = useState("");
  const [autoDetect, setAutoDetect] = useState(false);
  const [stabilityInterval, setStabilityInterval] = useState(2.0); // seconds
  const [stabilityProgress, setStabilityProgress] = useState(0); // 0 to 100%
  const [isStable, setIsStable] = useState(false);

  // Generation & preview state
  const [ui, setUi] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState("");
  const [error, setError] = useState("");
  const [activeModel, setActiveModel] = useState("gemini-3.5-flash");
  const [backendStatus, setBackendStatus] = useState("checking"); // 'connected' | 'offline' | 'checking'
  const [testMode, setTestMode] = useState(false);
  const [previewTab, setPreviewTab] = useState("ui"); // 'ui' | 'json'

  // Interactive component state inside the preview
  const [inputStates, setInputStates] = useState({});
  const [checkboxStates, setCheckboxStates] = useState({});
  const [activeTabStates, setActiveTabStates] = useState({});
  const [selectStates, setSelectStates] = useState({});
  const [toastMessage, setToastMessage] = useState("");

  // Trigger feedback toast
  const showToast = useCallback((msg) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage("");
    }, 2800);
  }, []);

  // Check backend health
  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/health`);
      if (res.ok) {
        const data = await res.json();
        setBackendStatus("connected");
        if (data.primary_model) {
          setActiveModel(data.primary_model);
        }
      } else {
        setBackendStatus("offline");
      }
    } catch {
      setBackendStatus("offline");
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const runCheck = async () => {
      if (mounted) await checkHealth();
    };
    runCheck();
    const interval = setInterval(runCheck, 15000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [checkHealth]);

  // Stop camera helper
  const stopCamera = useCallback(() => {
    if (autoDetectTimerRef.current) {
      clearInterval(autoDetectTimerRef.current);
      autoDetectTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (cameraRef.current) cameraRef.current.srcObject = null;
    setCameraOn(false);
    setStabilityProgress(0);
    setIsStable(false);
    stableDurationRef.current = 0;
  }, []);

  // Initialize canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  // Camera Management
  async function startCamera() {
    setCameraError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (cameraRef.current) {
        cameraRef.current.srcObject = stream;
        await cameraRef.current.play();
      }
      setCameraOn(true);
    } catch (err) {
      setCameraError(
        err.name === "NotAllowedError"
          ? "Camera permission denied. Please allow camera access in your browser."
          : `Camera error: ${err.message}`
      );
    }
  }

  const captureFrame = useCallback(() => {
    const video = cameraRef.current;
    if (!video || !video.videoWidth) {
      setCameraError("Camera video stream is not ready yet.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);

    setCapturedImage(dataUrl);
    setCameraError("");
    setError("");
  }, []);

  // Stability detection loop
  useEffect(() => {
    if (!cameraOn || !autoDetect) {
      if (autoDetectTimerRef.current) {
        clearInterval(autoDetectTimerRef.current);
        autoDetectTimerRef.current = null;
      }
      return;
    }

    if (!diffCanvasRef.current) {
      diffCanvasRef.current = document.createElement("canvas");
      diffCanvasRef.current.width = 64;
      diffCanvasRef.current.height = 48;
    }

    const diffCanvas = diffCanvasRef.current;
    const diffCtx = diffCanvas.getContext("2d");
    const checkIntervalMs = 350;

    autoDetectTimerRef.current = setInterval(() => {
      const video = cameraRef.current;
      if (!video || !video.videoWidth || loading) return;

      diffCtx.drawImage(video, 0, 0, 64, 48);
      const currentFrame = diffCtx.getImageData(0, 0, 64, 48).data;

      if (!prevFrameDataRef.current) {
        prevFrameDataRef.current = new Uint8ClampedArray(currentFrame);
        return;
      }

      const prev = prevFrameDataRef.current;
      let totalDiff = 0;
      const step = 4; // Sample every 4th pixel for speed
      let sampleCount = 0;

      for (let i = 0; i < currentFrame.length; i += step * 4) {
        const dr = Math.abs(currentFrame[i] - prev[i]);
        const dg = Math.abs(currentFrame[i + 1] - prev[i + 1]);
        const db = Math.abs(currentFrame[i + 2] - prev[i + 2]);
        totalDiff += (dr + dg + db) / 3;
        sampleCount++;
      }

      const avgDiff = totalDiff / sampleCount;
      prevFrameDataRef.current.set(currentFrame);

      // Threshold: below 14 means camera & sketch are sufficiently still
      const threshold = 14;

      if (avgDiff < threshold) {
        stableDurationRef.current += checkIntervalMs / 1000;
        const progress = Math.min(100, Math.round((stableDurationRef.current / stabilityInterval) * 100));
        setStabilityProgress(progress);

        if (stableDurationRef.current >= stabilityInterval) {
          setIsStable(true);
          captureFrame();
          stableDurationRef.current = 0;
          setStabilityProgress(0);
          showToast("✨ Sketch stabilized! Captured frame.");
        }
      } else {
        // Movement detected: degrade stability smoothly
        stableDurationRef.current = Math.max(0, stableDurationRef.current - 0.5);
        const progress = Math.min(100, Math.round((stableDurationRef.current / stabilityInterval) * 100));
        setStabilityProgress(progress);
        setIsStable(false);
      }
    }, checkIntervalMs);

    return () => {
      if (autoDetectTimerRef.current) {
        clearInterval(autoDetectTimerRef.current);
        autoDetectTimerRef.current = null;
      }
    };
  }, [cameraOn, autoDetect, stabilityInterval, loading, captureFrame, showToast]);

  // Drawing Canvas Handlers
  function startDrawing(event) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext("2d");

    drawing.current = true;
    ctx.beginPath();
    ctx.moveTo(
      ((event.clientX - rect.left) / rect.width) * canvas.width,
      ((event.clientY - rect.top) / rect.height) * canvas.height
    );
    canvas.setPointerCapture(event.pointerId);
  }

  function draw(event) {
    if (!drawing.current) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext("2d");

    ctx.lineWidth = tool === "erase" ? 28 : lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = tool === "erase" ? "#ffffff" : strokeColor;

    ctx.lineTo(
      ((event.clientX - rect.left) / rect.width) * canvas.width,
      ((event.clientY - rect.top) / rect.height) * canvas.height
    );
    ctx.stroke();
  }

  function stopDrawing() {
    drawing.current = false;
  }

  function clearCanvas() {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setError("");
  }

  // Pre-drawn sample sketches for instant testing
  function loadSampleSketch(type) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.font = "bold 15px sans-serif";
    ctx.fillStyle = "#1a1a1a";

    if (type === "dashboard") {
      // Top navbar
      ctx.strokeRect(30, 25, 660, 48);
      ctx.fillText("DA / CloudHub", 50, 55);
      ctx.fillText("[Overview]  [Metrics]  [Nodes]", 260, 55);
      ctx.strokeRect(580, 33, 90, 32);
      ctx.fillText("Deploy", 602, 54);

      // Stats row
      ctx.strokeRect(30, 95, 205, 75);
      ctx.fillText("Active Nodes", 45, 122);
      ctx.font = "bold 20px sans-serif";
      ctx.fillText("1,428", 45, 152);

      ctx.font = "bold 15px sans-serif";
      ctx.strokeRect(255, 95, 205, 75);
      ctx.fillText("Latency", 270, 122);
      ctx.font = "bold 20px sans-serif";
      ctx.fillText("14.2 ms", 270, 152);

      ctx.font = "bold 15px sans-serif";
      ctx.strokeRect(480, 95, 210, 75);
      ctx.fillText("Bandwidth", 495, 122);
      ctx.font = "bold 20px sans-serif";
      ctx.fillText("94 GB/s", 495, 152);

      // Side-by-side cards
      ctx.font = "bold 15px sans-serif";
      ctx.strokeRect(30, 195, 315, 215);
      ctx.fillText("Server Mesh (Glassmorphic)", 45, 225);
      ctx.strokeRect(45, 245, 285, 40);
      ctx.fillText("Region: us-east-1", 55, 270);
      ctx.strokeRect(45, 300, 285, 40);
      ctx.fillText("Status: HEALTHY", 55, 325);
      ctx.strokeRect(45, 355, 120, 38);
      ctx.fillText("Manage", 75, 380);

      ctx.strokeRect(375, 195, 315, 215);
      ctx.fillText("Threat Mitigation", 390, 225);
      ctx.strokeRect(390, 245, 285, 40);
      ctx.fillText("Zero Anomalies Detected", 400, 270);
      ctx.strokeRect(390, 300, 285, 40);
      ctx.fillText("Firewall: Active", 400, 325);
      ctx.strokeRect(390, 355, 120, 38);
      ctx.fillText("Audit", 425, 380);

    } else if (type === "login") {
      // Centered Auth Card
      ctx.strokeRect(170, 35, 380, 370);
      ctx.font = "bold 22px sans-serif";
      ctx.fillText("Developer Access", 260, 80);
      ctx.font = "14px sans-serif";
      ctx.fillText("Handwritten sketch note: translucent glass", 205, 110);

      // Inputs
      ctx.font = "bold 14px sans-serif";
      ctx.fillText("Work Email", 205, 150);
      ctx.strokeRect(205, 160, 310, 44);
      ctx.font = "13px sans-serif";
      ctx.fillText("name@company.com", 220, 188);

      ctx.font = "bold 14px sans-serif";
      ctx.fillText("Access Key / Password", 205, 230);
      ctx.strokeRect(205, 240, 310, 44);
      ctx.font = "13px sans-serif";
      ctx.fillText("••••••••••••", 220, 268);

      // Checkbox
      ctx.strokeRect(205, 300, 18, 18);
      ctx.fillText("Remember this workstation", 232, 314);

      // Button
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(205, 335, 310, 48);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 16px sans-serif";
      ctx.fillText("Authenticate Session  ->", 270, 365);

    } else if (type === "profile") {
      // Profile Layout
      ctx.strokeRect(30, 30, 660, 50);
      ctx.fillText("User Profile & Preferences", 50, 60);

      ctx.strokeRect(30, 105, 315, 300);
      ctx.fillText("Personal Info", 50, 135);
      ctx.arc(80, 185, 28, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText("Avatar", 60, 190);

      ctx.strokeRect(50, 230, 275, 42);
      ctx.fillText("Darshan Editz", 65, 256);

      ctx.strokeRect(50, 285, 275, 42);
      ctx.fillText("@darshan_dev", 65, 311);

      ctx.strokeRect(50, 345, 140, 40);
      ctx.fillText("Save Profile", 70, 370);

      ctx.strokeRect(375, 105, 315, 300);
      ctx.fillText("Interface Theme", 395, 135);
      ctx.strokeRect(395, 160, 20, 20);
      ctx.fillText("Lime-Green Accents", 425, 175);

      ctx.strokeRect(395, 200, 20, 20);
      ctx.fillText("Dark Glassmorphic UI", 425, 215);

      ctx.strokeRect(395, 240, 20, 20);
      ctx.fillText("High Performance Preview", 425, 255);

      ctx.strokeRect(395, 290, 275, 42);
      ctx.fillText("Select Role: Architect", 410, 316);
    }

    showToast(`Loaded "${type}" sketch sample`);
  }

  // Analyze sketch
  async function analyzeImage(imagePayload) {
    if (!imagePayload) {
      setError("Please draw on the sketch canvas or capture a paper sketch from the camera first.");
      return;
    }

    setLoading(true);
    setError("");
    setLoadingStep("1. Preparing image data...");

    try {
      setLoadingStep("2. Sending to Gemini Vision API...");
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: imagePayload,
          test_mode: testMode,
        }),
      });

      setLoadingStep("3. Synthesizing React interface...");
      const data = await res.json();

      if (!res.ok) {
        throw new Error(
          typeof data.detail === "string"
            ? data.detail
            : `Analysis failed (${res.status})`
        );
      }

      const parsedUi = data.ui || data.interface;
      if (!parsedUi || !Array.isArray(parsedUi.elements)) {
        throw new Error("Invalid UI format returned from backend.");
      }

      setUi(parsedUi);
      if (data.model) setActiveModel(data.model);
      showToast("✨ Interface built successfully!");
    } catch (err) {
      const isFailedFetch = err.message && err.message.toLowerCase().includes("failed to fetch");
      const friendlyDetail = isFailedFetch
        ? "Could not reach the backend server. If using Render, the backend may be cold-starting (takes ~30-50s) or check your CORS configuration."
        : err.message;
      setError(`${friendlyDetail} (Endpoint: ${API_URL})`);
    } finally {
      setLoading(false);
      setLoadingStep("");
    }
  }

  function buildFromCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const image = canvas.toDataURL("image/png");
    analyzeImage(image);
  }

  // Safe recursive component renderer
  function renderElement(element, index, parentKey = "root") {
    if (!element) return null;
    const key = `${parentKey}-${element.type}-${index}`;

    // Handle container elements with recursive children
    if (element.type === "row") {
      const children = Array.isArray(element.children) ? element.children : [];
      return (
        <div className="generated-row" key={key}>
          {children.map((child, idx) => renderElement(child, idx, key))}
        </div>
      );
    }

    if (element.type === "column") {
      const children = Array.isArray(element.children) ? element.children : [];
      return (
        <div className="generated-column" key={key}>
          {children.map((child, idx) => renderElement(child, idx, key))}
        </div>
      );
    }

    if (element.type === "grid") {
      const cols = element.columns || 2;
      const children = Array.isArray(element.children) ? element.children : [];
      return (
        <div
          className="generated-grid"
          key={key}
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {children.map((child, idx) => renderElement(child, idx, key))}
        </div>
      );
    }

    if (element.type === "card") {
      const children = Array.isArray(element.children) ? element.children : [];
      const isGlass = element.glassmorphism !== false;
      return (
        <div className={`generated-card ${isGlass ? "glassmorphic" : ""}`} key={key}>
          {element.title && <h3 className="card-title">{element.title}</h3>}
          {element.text && <p className="card-body">{element.text}</p>}
          {children.length > 0 && (
            <div className="card-children">
              {children.map((child, idx) => renderElement(child, idx, key))}
            </div>
          )}
        </div>
      );
    }

    if (element.type === "navbar") {
      const links = Array.isArray(element.links) ? element.links : [];
      const actions = Array.isArray(element.actions) ? element.actions : [];
      return (
        <nav className="generated-navbar" key={key}>
          <div className="navbar-brand">
            <span className="brand-dot" />
            <span>{element.brand || "SketchFlow"}</span>
          </div>
          <div className="navbar-links">
            {links.map((link, idx) => (
              <a
                href="#link"
                key={`${key}-link-${idx}`}
                className="nav-link"
                onClick={(e) => {
                  e.preventDefault();
                  showToast(`Navigation: ${link}`);
                }}
              >
                {link}
              </a>
            ))}
          </div>
          {actions.length > 0 && (
            <div className="navbar-actions">
              {actions.map((act, idx) => renderElement(act, idx, key))}
            </div>
          )}
        </nav>
      );
    }

    if (element.type === "heading") {
      const text = element.text || "Heading";
      if (element.level === 1) return <h1 key={key} className="generated-h1">{text}</h1>;
      if (element.level === 3) return <h3 key={key} className="generated-h3">{text}</h3>;
      return <h2 key={key} className="generated-h2">{text}</h2>;
    }

    if (element.type === "text") {
      const text = element.text || "";
      const variant = element.variant || "body";
      return <p key={key} className={`generated-text ${variant}`}>{text}</p>;
    }

    if (element.type === "input") {
      const label = element.label || element.text || "Input";
      const val = inputStates[key] ?? "";
      return (
        <label className="generated-field" key={key}>
          <span className="field-label">{label}</span>
          <input
            type={element.inputType || "text"}
            placeholder={element.placeholder || `Enter ${label}...`}
            value={val}
            onChange={(e) => setInputStates({ ...inputStates, [key]: e.target.value })}
          />
        </label>
      );
    }

    if (element.type === "textarea") {
      const label = element.label || element.text || "Notes";
      const val = inputStates[key] ?? "";
      return (
        <label className="generated-field" key={key}>
          <span className="field-label">{label}</span>
          <textarea
            rows={element.rows || 3}
            placeholder={element.placeholder || "Enter details..."}
            value={val}
            onChange={(e) => setInputStates({ ...inputStates, [key]: e.target.value })}
          />
        </label>
      );
    }

    if (element.type === "button") {
      const text = element.text || "Action";
      const variant = element.variant || "primary";
      return (
        <button
          key={key}
          type="button"
          className={`generated-btn btn-${variant}`}
          onClick={() => showToast(`✨ Button clicked: "${text}"`)}
        >
          {element.icon === "lock" && <Lock size={15} />}
          {element.icon === "search" && <Search size={15} />}
          {element.icon === "settings" && <Settings size={15} />}
          {element.icon === "check" && <Check size={15} />}
          <span>{text}</span>
          {element.icon === "arrow-right" && <ArrowRight size={15} />}
        </button>
      );
    }

    if (element.type === "tabs") {
      const items = Array.isArray(element.items) ? element.items : ["Tab 1", "Tab 2"];
      const currentTab = activeTabStates[key] ?? element.activeIndex ?? 0;
      return (
        <div className="generated-tabs" key={key}>
          {items.map((tab, idx) => (
            <button
              key={`${key}-tab-${idx}`}
              type="button"
              className={`tab-item ${currentTab === idx ? "active" : ""}`}
              onClick={() => {
                setActiveTabStates({ ...activeTabStates, [key]: idx });
                showToast(`Active tab: ${tab}`);
              }}
            >
              {tab}
            </button>
          ))}
        </div>
      );
    }

    if (element.type === "checkbox") {
      const label = element.label || element.text || "Checkbox";
      const checked = checkboxStates[key] ?? element.checked ?? false;
      return (
        <label className="generated-checkbox" key={key}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setCheckboxStates({ ...checkboxStates, [key]: e.target.checked })}
          />
          <span>{label}</span>
        </label>
      );
    }

    if (element.type === "select") {
      const label = element.label || element.text || "Select";
      const options = Array.isArray(element.options) ? element.options : ["Option 1", "Option 2"];
      const val = selectStates[key] ?? "";
      return (
        <label className="generated-field" key={key}>
          <span className="field-label">{label}</span>
          <select
            value={val}
            onChange={(e) => setSelectStates({ ...selectStates, [key]: e.target.value })}
          >
            <option value="" disabled>{element.placeholder || "Choose option..."}</option>
            {options.map((opt, idx) => (
              <option key={`${key}-opt-${idx}`} value={opt}>{opt}</option>
            ))}
          </select>
        </label>
      );
    }

    if (element.type === "badge") {
      return (
        <span key={key} className={`generated-badge badge-${element.variant || "accent"}`}>
          {element.text || "Active"}
        </span>
      );
    }

    if (element.type === "stats") {
      return (
        <div className="generated-stat" key={key}>
          <span className="stat-label">{element.label || "Metric"}</span>
          <span className="stat-value">{element.value || "100%"}</span>
          {element.change && <span className="stat-change">{element.change}</span>}
        </div>
      );
    }

    if (element.type === "icon") {
      const name = (element.name || "sparkles").toLowerCase();
      let IconComponent = Sparkles;
      if (name.includes("search")) IconComponent = Search;
      else if (name.includes("user")) IconComponent = User;
      else if (name.includes("bell")) IconComponent = Bell;
      else if (name.includes("settings")) IconComponent = Settings;
      else if (name.includes("heart")) IconComponent = Heart;
      else if (name.includes("star")) IconComponent = Star;
      else if (name.includes("home")) IconComponent = Home;
      else if (name.includes("mail")) IconComponent = Mail;
      else if (name.includes("lock")) IconComponent = Lock;
      else if (name.includes("check")) IconComponent = Check;

      return (
        <div className="generated-icon-wrap" key={key}>
          <IconComponent size={20} className="ui-icon" />
          {element.label && <span className="icon-label">{element.label}</span>}
        </div>
      );
    }

    if (element.type === "divider") {
      return <hr className="generated-divider" key={key} />;
    }

    return null;
  }

  return (
    <main className="app-shell">
      {/* Interactive feedback toast */}
      {toastMessage && (
        <div className="interactive-toast">
          <CheckCircle2 size={16} />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Header */}
      <header className="topbar">
        <div className="brand-mark">SF<span>✳</span></div>
        <div>
          <h1>SketchFlow</h1>
          <p>Digital Architecture • Hand-drawn sketches to React UI</p>
        </div>

        <div className="header-meta">
          <button
            type="button"
            className={`mode-toggle-btn ${testMode ? "demo-active" : ""}`}
            onClick={() => setTestMode(!testMode)}
            title="Toggle between Live Gemini API and Offline Demo Mode"
          >
            <Sliders size={13} />
            <span>{testMode ? "DEMO MODE (OFFLINE)" : "LIVE API"}</span>
          </button>

          <div className="local-status">
            <span className={`status-indicator ${backendStatus}`} />
            {backendStatus === "connected" ? (
              <span>ONLINE • {activeModel.toUpperCase()}</span>
            ) : (
              <span>BACKEND OFFLINE</span>
            )}
          </div>
        </div>
      </header>

      {/* Intro section */}
      <section className="intro">
        <span className="eyebrow">NEURAL SKETCH-TO-INTERFACE ENGINE</span>
        <h2>Draw it on paper. <span>Build it in React.</span></h2>
        <p>Point your webcam at an A4 paper sketch or draw directly on the canvas. Gemini extracts structure, layout, and handwriting into interactive React components.</p>
      </section>

      {/* Main Two-Panel Workspace */}
      <section className="workspace">
        {/* Left Panel: Digital Canvas & Camera Scanner */}
        <div className="panel drawing-panel">
          <div className="panel-heading">
            <div><Pencil size={17} /><h3>Sketch Studio</h3></div>
            <span>01 / INPUT MATRIX</span>
          </div>

          {/* Canvas Toolbar */}
          <div className="toolbar">
            <button
              type="button"
              className={tool === "draw" ? "tool active" : "tool"}
              onClick={() => setTool("draw")}
            >
              <Pencil size={15} /> Draw
            </button>
            <button
              type="button"
              className={tool === "erase" ? "tool active" : "tool"}
              onClick={() => setTool("erase")}
            >
              <Eraser size={15} /> Erase
            </button>
            <button
              type="button"
              className="tool clear"
              onClick={clearCanvas}
            >
              <Trash2 size={15} /> Clear
            </button>

            {/* Stroke Thickness Controls */}
            <div className="stroke-controls">
              {[2, 4, 8].map((size) => (
                <button
                  key={size}
                  type="button"
                  className={`size-dot-btn ${lineWidth === size ? "active" : ""}`}
                  onClick={() => setLineWidth(size)}
                  title={`Brush width: ${size}px`}
                >
                  <span style={{ width: size + 2, height: size + 2 }} />
                </button>
              ))}
              <input
                type="color"
                value={strokeColor}
                onChange={(e) => setStrokeColor(e.target.value)}
                className="color-picker-input"
                title="Brush color"
              />
            </div>
          </div>

          {/* Sample template quick loaders */}
          <div className="sample-sketch-row">
            <span className="sample-label">Quick Sketches:</span>
            <button type="button" className="sample-pill" onClick={() => loadSampleSketch("dashboard")}>
              SaaS Dashboard
            </button>
            <button type="button" className="sample-pill" onClick={() => loadSampleSketch("login")}>
              Glassmorphic Auth
            </button>
            <button type="button" className="sample-pill" onClick={() => loadSampleSketch("profile")}>
              User Profile
            </button>
          </div>

          {/* Canvas Wrapper */}
          <div className="canvas-wrap">
            <canvas
              ref={canvasRef}
              width={720}
              height={440}
              onPointerDown={startDrawing}
              onPointerMove={draw}
              onPointerUp={stopDrawing}
              onPointerCancel={stopDrawing}
            />
            <div className="canvas-hint"><MousePointer2 size={13} /> Draw wireframes with mouse or stylus</div>
          </div>

          {/* Primary Action Button */}
          <button
            type="button"
            className="generate-button"
            disabled={loading}
            onClick={buildFromCanvas}
          >
            <Sparkles size={18} />
            {loading ? (loadingStep || "Analyzing sketch...") : "Build UI from Canvas"}
            <span>↗</span>
          </button>

          {/* Webcam Section */}
          <div className="camera-section">
            <div className="panel-heading">
              <div><Camera size={17} /><h3>Paper Scanner</h3></div>
              <span>03 / WEBCAM A4 SCAN</span>
            </div>

            {/* Video preview */}
            <div className={`camera-view ${isStable ? "stable-glow" : ""}`}>
              <video ref={cameraRef} autoPlay muted playsInline />
              {!cameraOn && (
                <div className="camera-placeholder">
                  <Camera size={34} />
                  <p>Hold an A4 paper sketch in front of your camera</p>
                  <small>Auto-stabilizer captures frame when sketch is held still</small>
                </div>
              )}

              {/* Stability Progress Overlay */}
              {cameraOn && autoDetect && (
                <div className="stability-overlay">
                  <div className="stability-bar-wrap">
                    <div
                      className="stability-bar-fill"
                      style={{ width: `${stabilityProgress}%` }}
                    />
                  </div>
                  <span className="stability-text">
                    {stabilityProgress > 0
                      ? `Holding steady... ${stabilityProgress}%`
                      : "Hold sketch steady..."}
                  </span>
                </div>
              )}
            </div>

            {/* Camera controls */}
            <div className="camera-controls">
              {!cameraOn ? (
                <button type="button" className="tool active" onClick={startCamera}>
                  <Camera size={15} /> Start camera
                </button>
              ) : (
                <button type="button" className="tool" onClick={stopCamera}>
                  <CameraOff size={15} /> Stop camera
                </button>
              )}

              <button
                type="button"
                className="tool"
                onClick={captureFrame}
                disabled={!cameraOn || loading}
              >
                <Camera size={15} /> Capture frame
              </button>

              {cameraOn && (
                <label className="auto-detect-toggle" title="Captures automatically when paper sketch is held still">
                  <input
                    type="checkbox"
                    checked={autoDetect}
                    onChange={(e) => setAutoDetect(e.target.checked)}
                  />
                  <span>Auto-detect stable sketch</span>
                </label>
              )}
            </div>

            {/* Stability interval setting */}
            {cameraOn && autoDetect && (
              <div className="stability-config-row">
                <span>Hold duration:</span>
                {[1.5, 2.0, 3.0].map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    className={`duration-chip ${stabilityInterval === sec ? "active" : ""}`}
                    onClick={() => setStabilityInterval(sec)}
                  >
                    {sec}s
                  </button>
                ))}
                <button
                  type="button"
                  className="manual-build-chip"
                  onClick={captureFrame}
                  disabled={loading}
                >
                  <Play size={12} /> Build Now
                </button>
              </div>
            )}

            {cameraError && <p className="camera-error">{cameraError}</p>}

            {/* Display Captured Frame */}
            {capturedImage && (
              <div className="captured-preview">
                <div className="captured-header">
                  <span>Captured Sketch Frame</span>
                  <button
                    type="button"
                    className="discard-btn"
                    onClick={() => setCapturedImage("")}
                    disabled={loading}
                  >
                    Discard
                  </button>
                </div>

                <div className="captured-img-wrap">
                  <img src={capturedImage} alt="Captured paper sketch" />
                </div>

                <div className="captured-actions">
                  <button
                    type="button"
                    className="generate-button primary-accent"
                    disabled={loading}
                    onClick={() => analyzeImage(capturedImage)}
                  >
                    <Sparkles size={18} />
                    {loading ? (loadingStep || "Analyzing...") : "Analyze & Build UI"}
                    <span>↗</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Panel: Live Interactive Preview */}
        <div className="panel preview-panel">
          <div className="panel-heading">
            <div className="preview-heading-left">
              <Monitor size={17} />
              <h3>Live Interface</h3>
            </div>

            <div className="preview-tab-controls">
              <button
                type="button"
                className={`tab-toggle ${previewTab === "ui" ? "active" : ""}`}
                onClick={() => setPreviewTab("ui")}
              >
                <Eye size={13} /> Interactive UI
              </button>
              <button
                type="button"
                className={`tab-toggle ${previewTab === "json" ? "active" : ""}`}
                onClick={() => setPreviewTab("json")}
              >
                <Code size={13} /> Architecture JSON
              </button>
            </div>

            <span>02 / REACT SYNTHESIS</span>
          </div>

          {/* Preview Viewport */}
          <div className="preview-screen">
            {loading ? (
              <div className="empty-preview loading-view">
                <div className="loading-orbit">
                  <Sparkles size={32} className="spin-icon" />
                </div>
                <h3>Synthesizing Interface...</h3>
                <p className="loading-step-text">{loadingStep || "Gemini is translating sketch layout & handwritten labels."}</p>
                <div className="loading-bar-indeterminate" />
              </div>
            ) : error ? (
              <div className="empty-preview error-view">
                <div className="error-icon"><AlertCircle size={32} /></div>
                <h3>Could not build interface</h3>
                <p className="error-desc">{error}</p>

                <div className="error-action-row">
                  {capturedImage && (
                    <button
                      type="button"
                      className="tool active retry-btn"
                      onClick={() => analyzeImage(capturedImage)}
                      disabled={loading}
                    >
                      <RefreshCw size={15} /> Retry with captured image
                    </button>
                  )}
                  <button
                    type="button"
                    className="tool"
                    onClick={() => {
                      setTestMode(true);
                      showToast("Switched to Offline Demo Mode for immediate testing");
                    }}
                  >
                    Try in Offline Demo Mode
                  </button>
                </div>
              </div>
            ) : ui ? (
              previewTab === "ui" ? (
                <div
                  className={`generated-ui-container ${ui.style?.glassmorphism ? "glassmorphic" : ""}`}
                  style={{
                    "--accent": ui.style?.accentColor || "#c5fa65",
                  }}
                >
                  <div className="generated-ui-header">
                    <h2>{ui.title || "Interface"}</h2>
                    {ui.subtitle && <p className="ui-subtitle">{ui.subtitle}</p>}
                  </div>

                  <div className="generated-elements-stack">
                    {ui.elements.map((el, idx) => renderElement(el, idx))}
                  </div>

                  <div className="generated-ui-footer">
                    <span>Synthesized by {activeModel} • React Component Tree</span>
                  </div>
                </div>
              ) : (
                <div className="json-architecture-viewer">
                  <div className="json-meta-bar">
                    <span>SCHEMA: UI_TREE_V2</span>
                    <span>{ui.elements?.length || 0} COMPONENTS</span>
                  </div>
                  <pre className="json-code-block">
                    {JSON.stringify(ui, null, 2)}
                  </pre>
                </div>
              )
            ) : (
              <div className="empty-preview">
                <div className="preview-icon"><Monitor size={28} /></div>
                <h3>Your creation appears here</h3>
                <p>Draw a sketch on the canvas or point your webcam at a paper wireframe and click <b>Analyze & Build</b>.</p>
                <div className="empty-hint-row">
                  <button
                    type="button"
                    className="sample-pill"
                    onClick={() => loadSampleSketch("dashboard")}
                  >
                    Try Dashboard Sample
                  </button>
                  <button
                    type="button"
                    className="sample-pill"
                    onClick={() => loadSampleSketch("login")}
                  >
                    Try Login Sample
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Footer Bar */}
          <div className="preview-footer">
            <span className="green-dot" /> Preview environment <span>React 19 • Gemini Vision</span>
          </div>

          {/* Regenerate Action */}
          {ui && capturedImage && (
            <div className="regenerate-row">
              <button
                type="button"
                className="tool"
                disabled={loading}
                onClick={() => analyzeImage(capturedImage)}
              >
                <RefreshCw size={15} /> Regenerate from same captured image
              </button>
            </div>
          )}
        </div>
      </section>

      <footer>
        BUILT WITH REACT <span>✳</span> POWERED BY GEMINI AI <span>✳</span> SKETCHFLOW DIGITAL ARCHITECTURE
      </footer>
    </main>
  );
}
