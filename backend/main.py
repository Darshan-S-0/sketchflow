import os
import re
import json
import base64
from pathlib import Path
from typing import Optional, List, Dict, Any

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Ensure .env is loaded from backend directory
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(dotenv_path=BASE_DIR / ".env")
load_dotenv()  # fallback to parent or current working directory

app = FastAPI(title="SketchFlow API", description="Converts hand-drawn UI sketches into structured React UI JSON")

# Allowed CORS origins
env_origins = [
    origin.strip().rstrip("/")
    for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]

# If FRONTEND_URL is provided, include it
frontend_url = os.getenv("FRONTEND_URL", "").strip().rstrip("/")
if frontend_url and frontend_url not in env_origins:
    env_origins.append(frontend_url)

DEFAULT_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://sketchflow-6d65.onrender.com",
]

ALLOWED_ORIGINS = list(dict.fromkeys(DEFAULT_ORIGINS + env_origins))

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"^https://[a-zA-Z0-9_-]+\.onrender\.com$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
PRIMARY_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash").strip()

# Reliable Gemini models with vision support (confirmed working)
FALLBACK_MODELS = [
    PRIMARY_MODEL,
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
]
CANDIDATE_MODELS = list(dict.fromkeys([m for m in FALLBACK_MODELS if m]))

PROMPT = """You are an expert UI/UX designer and frontend architect specializing in converting hand-drawn wireframes and sketches into polished modern web interfaces.

Analyze this hand-drawn user interface sketch very carefully.

Your task:
1. Identify all visible UI elements, handwritten text labels, icons, buttons, inputs, cards, and navigation items.
2. Read handwritten annotations or styling notes (e.g., 'dark mode', 'glassmorphism', 'translucent', 'rounded', 'lime accent', 'tabs', 'stats').
3. PRESERVE EXACT SPATIAL RELATIONSHIPS:
   - If elements are side-by-side horizontally, group them inside a container of type "row" or "grid".
   - If elements are stacked vertically, keep them in that vertical order.
   - If elements are grouped within a drawn box/card frame, place them inside a "card" container as "children".
   - If there is a top header or navigation bar with logo/brand and navigation links/buttons, use type "navbar".

Return a strictly valid JSON object matching this schema:
{
  "title": "Clear UI Title from sketch",
  "subtitle": "Short descriptive subtitle or tagline",
  "style": {
    "theme": "dark" or "light",
    "glassmorphism": true or false,
    "accentColor": "#c5fa65" or other hex color,
    "layout": "vertical" or "horizontal" or "centered"
  },
  "elements": [
    {
      "type": "navbar",
      "brand": "App or Brand Name",
      "links": ["Home", "Features", "Analytics"],
      "actions": [{"type": "button", "text": "Sign In", "variant": "outline"}]
    },
    {
      "type": "heading",
      "text": "Section or Page Heading",
      "level": 1
    },
    {
      "type": "text",
      "text": "Descriptive copy or label"
    },
    {
      "type": "row",
      "children": [
        {"type": "card", "title": "Card 1", "text": "Details"},
        {"type": "card", "title": "Card 2", "text": "Details"}
      ]
    },
    {
      "type": "card",
      "title": "Card Title",
      "text": "Card body",
      "glassmorphism": true,
      "children": []
    },
    {
      "type": "input",
      "label": "Email Address",
      "placeholder": "Enter your email...",
      "inputType": "email"
    },
    {
      "type": "button",
      "text": "Get Started",
      "variant": "primary",
      "icon": "arrow-right"
    },
    {
      "type": "tabs",
      "items": ["Overview", "Activity", "Settings"],
      "activeIndex": 0
    },
    {
      "type": "icon",
      "name": "search",
      "label": "Search"
    },
    {
      "type": "checkbox",
      "label": "I agree to the terms",
      "checked": false
    },
    {
      "type": "select",
      "label": "Category",
      "options": ["Option 1", "Option 2"]
    },
    {
      "type": "badge",
      "text": "Active",
      "variant": "accent"
    },
    {
      "type": "divider"
    }
  ]
}

Supported element types:
- "navbar": brand (string), links (list of strings), actions (list of button objects)
- "heading": text (string), level (1, 2, or 3)
- "text": text (string), variant ("body", "caption", "lead")
- "button": text (string), variant ("primary", "secondary", "outline", "ghost", "danger"), icon (string)
- "input": label (string), placeholder (string), inputType ("text", "email", "password", "number", "search")
- "textarea": label (string), placeholder (string), rows (number)
- "card": title (string), text (string), glassmorphism (bool), children (list of elements)
- "row": children (list of elements to display side by side), gap (string)
- "column": children (list of elements to display stacked)
- "grid": columns (number, e.g. 2 or 3), children (list of elements)
- "tabs": items (list of strings), activeIndex (number)
- "icon": name ("search", "user", "bell", "settings", "heart", "star", "home", "mail", "camera", "check", "arrow-right", "lock"), label (string)
- "badge": text (string), variant ("accent", "neutral", "success")
- "checkbox": label (string), checked (bool)
- "select": label (string), placeholder (string), options (list of strings)
- "stats": label (string), value (string), change (string)
- "divider"

Rules:
1. ONLY return pure JSON. No Markdown formatting, no explanations, no backticks.
2. If handwriting notes say 'glass' or 'glassmorphic', set style.glassmorphism = true.
3. If elements are drawn side-by-side (such as 2 or 3 cards or button rows), wrap them in a "row" or "grid" container.
4. Keep original order from top to bottom.
"""


class SketchRequest(BaseModel):
    image: str
    test_mode: Optional[bool] = False


# Built-in demo sample interfaces for offline testing or instant showcase
DEMO_TEMPLATES: Dict[str, Dict[str, Any]] = {
    "dashboard": {
        "title": "Cloud Analytics Hub",
        "subtitle": "Real-time metrics & system telemetry",
        "style": {
            "theme": "dark",
            "glassmorphism": True,
            "accentColor": "#c5fa65",
            "layout": "vertical"
        },
        "elements": [
            {
                "type": "navbar",
                "brand": "AetherPulse",
                "links": ["Overview", "Nodes", "Security", "Logs"],
                "actions": [
                    {"type": "button", "text": "New Deploy", "variant": "primary", "icon": "arrow-right"}
                ]
            },
            {
                "type": "row",
                "children": [
                    {"type": "stats", "label": "Active Nodes", "value": "1,428", "change": "+12.4% vs last week"},
                    {"type": "stats", "label": "Avg Latency", "value": "14.2ms", "change": "-3.1ms optimal"},
                    {"type": "stats", "label": "Throughput", "value": "94.8 GB/s", "change": "+8.2% peak"}
                ]
            },
            {
                "type": "tabs",
                "items": ["System Metrics", "Container Mesh", "Alert Rules"],
                "activeIndex": 0
            },
            {
                "type": "row",
                "children": [
                    {
                        "type": "card",
                        "title": "Core Gateway Status",
                        "text": "Operating within normal thermal and queue thresholds.",
                        "glassmorphism": True,
                        "children": [
                            {"type": "badge", "text": "HEALTHY: GREEN", "variant": "accent"},
                            {"type": "text", "text": "Uptime: 99.992% over trailing 90 days across 4 geographical regions."},
                            {"type": "button", "text": "Inspect Gateway", "variant": "outline", "icon": "settings"}
                        ]
                    },
                    {
                        "type": "card",
                        "title": "Threat Detection Stream",
                        "text": "Automated anomaly mitigation with continuous packet inspection.",
                        "glassmorphism": True,
                        "children": [
                            {"type": "badge", "text": "ZERO INCIDENTS", "variant": "neutral"},
                            {"type": "text", "text": "Last deep scan completed 4 minutes ago with zero false positives."},
                            {"type": "button", "text": "View Audit Log", "variant": "ghost", "icon": "search"}
                        ]
                    }
                ]
            }
        ]
    },
    "login": {
        "title": "Welcome Back",
        "subtitle": "Sign in to access your digital architecture workspace",
        "style": {
            "theme": "dark",
            "glassmorphism": True,
            "accentColor": "#c5fa65",
            "layout": "centered"
        },
        "elements": [
            {
                "type": "card",
                "title": "Account Authentication",
                "text": "Enter your developer credentials below.",
                "glassmorphism": True,
                "children": [
                    {
                        "type": "input",
                        "label": "Email Address",
                        "placeholder": "darshan@example.com",
                        "inputType": "email"
                    },
                    {
                        "type": "input",
                        "label": "Master Key / Password",
                        "placeholder": "••••••••••••",
                        "inputType": "password"
                    },
                    {
                        "type": "row",
                        "children": [
                            {"type": "checkbox", "label": "Remember device for 30 days", "checked": True},
                            {"type": "text", "text": "Forgot key?", "variant": "caption"}
                        ]
                    },
                    {
                        "type": "button",
                        "text": "Authenticate Session",
                        "variant": "primary",
                        "icon": "lock"
                    }
                ]
            }
        ]
    },
    "profile": {
        "title": "User Profile & Security",
        "subtitle": "Manage team roles, access keys, and interface preferences",
        "style": {
            "theme": "dark",
            "glassmorphism": True,
            "accentColor": "#c5fa65",
            "layout": "vertical"
        },
        "elements": [
            {
                "type": "navbar",
                "brand": "SketchFlow Profile",
                "links": ["General", "Billing", "Team", "API Keys"],
                "actions": [
                    {"type": "button", "text": "Save Changes", "variant": "primary", "icon": "check"}
                ]
            },
            {
                "type": "row",
                "children": [
                    {
                        "type": "card",
                        "title": "Personal Details",
                        "glassmorphism": True,
                        "children": [
                            {"type": "input", "label": "Full Name", "placeholder": "Darshan Editz", "inputType": "text"},
                            {"type": "input", "label": "Handle", "placeholder": "@darshan_dev", "inputType": "text"},
                            {"type": "select", "label": "Primary Role", "options": ["Architect", "Staff Engineer", "UI Designer"]}
                        ]
                    },
                    {
                        "type": "card",
                        "title": "Interface Preferences",
                        "glassmorphism": True,
                        "children": [
                            {"type": "checkbox", "label": "Enable Lime-Green accent theme", "checked": True},
                            {"type": "checkbox", "label": "High-fidelity translucent glassmorphism", "checked": True},
                            {"type": "checkbox", "label": "Real-time camera frame stability sync", "checked": True}
                        ]
                    }
                ]
            }
        ]
    }
}


def parse_and_validate_image(image_string: str) -> tuple[str, str]:
    """Validates base64 / data-url image and returns (base64_data, mime_type)."""
    if not image_string or not isinstance(image_string, str):
        raise HTTPException(400, "No image provided.")

    mime = "image/jpeg"
    cleaned_string = image_string.strip()

    if cleaned_string.startswith("data:"):
        try:
            header, cleaned_string = cleaned_string.split(",", 1)
            mime_part = header[5:].split(";")[0].strip().lower()
            if mime_part:
                mime = mime_part
        except ValueError:
            raise HTTPException(400, "Invalid image data URL formatting.")

    if mime not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
        # Default to jpeg if unrecognized but valid base64
        mime = "image/jpeg"

    try:
        raw_bytes = base64.b64decode(cleaned_string, validate=False)
    except Exception as exc:
        raise HTTPException(400, f"Invalid base64 image data: {exc}")

    if not raw_bytes or len(raw_bytes) < 32:
        raise HTTPException(400, "The captured image data is empty or incomplete.")

    if len(raw_bytes) > 15 * 1024 * 1024:
        raise HTTPException(413, "Image exceeds the maximum allowable size of 15 MB.")

    return base64.b64encode(raw_bytes).decode("utf-8"), mime


def repair_and_parse_json(raw_text: str) -> Dict[str, Any]:
    """Robustly parses JSON even with markdown fences, trailing commas, or extra text."""
    text = raw_text.strip()

    # Remove markdown code fences if present
    if "```" in text:
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.MULTILINE)
        text = re.sub(r"```\s*$", "", text, flags=re.MULTILINE).strip()

    # Extract outer JSON block
    start = text.find("{")
    end = text.rfind("}")

    if start == -1 or end == -1 or end <= start:
        # Check if an array was returned instead
        start_arr = text.find("[")
        end_arr = text.rfind("]")
        if start_arr != -1 and end_arr != -1 and end_arr > start_arr:
            try:
                arr_data = json.loads(text[start_arr:end_arr + 1])
                return {"title": "Detected Interface", "elements": arr_data, "style": {"theme": "dark"}}
            except Exception:
                pass
        raise ValueError("No JSON object structure detected in the Gemini response.")

    json_candidate = text[start:end + 1]

    # Attempt 1: Direct parse
    try:
        return json.loads(json_candidate)
    except json.JSONDecodeError:
        pass

    # Attempt 2: Clean trailing commas before closing braces/brackets
    cleaned = re.sub(r",\s*([\]}])", r"\1", json_candidate)
    # Remove control characters that may break parsing
    cleaned = re.sub(r"[\x00-\x1f\x7f-\x9f]", lambda m: " " if m.group(0) not in "\r\n\t" else m.group(0), cleaned)

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Malformed JSON from AI model: {exc}")


def sanitize_element(item: Any) -> Optional[Dict[str, Any]]:
    """Sanitizes an element or container recursively to ensure safe, schema-compliant UI structure."""
    if isinstance(item, str):
        val = item.replace("_", " ").strip()
        low = val.lower()
        if "heading" in low or "title" in low:
            return {"type": "heading", "text": val, "level": 2}
        elif "button" in low:
            return {"type": "button", "text": val, "variant": "primary"}
        elif "input" in low or "search" in low:
            return {"type": "input", "label": val, "placeholder": f"Enter {val}..."}
        elif "card" in low:
            return {"type": "card", "title": val, "children": []}
        return {"type": "text", "text": val}

    if not isinstance(item, dict):
        return None

    raw_type = str(item.get("type", "text")).lower().strip()

    # Normalize aliases
    if raw_type in ("nav", "navigation", "header", "topbar"):
        raw_type = "navbar"
    elif raw_type in ("h1", "h2", "h3", "title"):
        raw_type = "heading"
    elif raw_type in ("p", "paragraph", "label", "caption"):
        raw_type = "text"
    elif raw_type in ("btn", "action"):
        raw_type = "button"
    elif raw_type in ("text_field", "textfield", "textbox", "search_bar"):
        raw_type = "input"
    elif raw_type in ("box", "panel", "container_card"):
        raw_type = "card"
    elif raw_type in ("flex_row", "horizontal_row", "side_by_side", "columns"):
        raw_type = "row"
    elif raw_type in ("flex_column", "vertical_column", "stack"):
        raw_type = "column"
    elif raw_type in ("checkbox_field", "check"):
        raw_type = "checkbox"
    elif raw_type in ("dropdown", "combobox"):
        raw_type = "select"
    elif raw_type in ("tag", "chip", "pill"):
        raw_type = "badge"
    elif raw_type in ("metric", "stat"):
        raw_type = "stats"
    elif raw_type in ("hr", "line", "separator"):
        raw_type = "divider"

    # Container elements: normalize children recursively
    if raw_type in ("row", "column", "grid", "card"):
        raw_children = item.get("children", [])
        if not isinstance(raw_children, list):
            raw_children = []
        cleaned_children = []
        for child in raw_children:
            sc = sanitize_element(child)
            if sc:
                cleaned_children.append(sc)

        res: Dict[str, Any] = {
            "type": raw_type,
            "children": cleaned_children,
        }
        if raw_type == "card":
            res["title"] = str(item.get("title", item.get("text", "")))
            res["text"] = str(item.get("text", "")) if "title" in item else ""
            res["glassmorphism"] = bool(item.get("glassmorphism", True))
        elif raw_type == "grid":
            res["columns"] = int(item.get("columns", 2))
        return res

    # Specific component types
    if raw_type == "navbar":
        links = item.get("links", ["Home", "Features", "About"])
        if not isinstance(links, list):
            links = ["Home", "Features"]
        actions = item.get("actions", [])
        cleaned_actions = []
        if isinstance(actions, list):
            for a in actions:
                sa = sanitize_element(a)
                if sa:
                    cleaned_actions.append(sa)
        return {
            "type": "navbar",
            "brand": str(item.get("brand", item.get("title", "App"))),
            "links": [str(x) for x in links],
            "actions": cleaned_actions,
        }

    if raw_type == "heading":
        return {
            "type": "heading",
            "text": str(item.get("text", item.get("label", "Heading"))),
            "level": int(item.get("level", 2)),
        }

    if raw_type == "button":
        return {
            "type": "button",
            "text": str(item.get("text", item.get("label", "Button"))),
            "variant": str(item.get("variant", "primary")).lower(),
            "icon": str(item.get("icon", "")) if item.get("icon") else None,
        }

    if raw_type == "input":
        return {
            "type": "input",
            "label": str(item.get("label", item.get("text", "Input"))),
            "placeholder": str(item.get("placeholder", item.get("label", "Enter value..."))),
            "inputType": str(item.get("inputType", "text")).lower(),
        }

    if raw_type == "textarea":
        return {
            "type": "textarea",
            "label": str(item.get("label", item.get("text", "Message"))),
            "placeholder": str(item.get("placeholder", "Enter details...")),
            "rows": int(item.get("rows", 3)),
        }

    if raw_type == "tabs":
        items = item.get("items", ["Tab 1", "Tab 2"])
        if not isinstance(items, list):
            items = ["Tab 1", "Tab 2"]
        return {
            "type": "tabs",
            "items": [str(t) for t in items],
            "activeIndex": int(item.get("activeIndex", 0)),
        }

    if raw_type == "icon":
        name = str(item.get("name", item.get("icon", "sparkles"))).lower().replace("_", "-")
        return {
            "type": "icon",
            "name": name,
            "label": str(item.get("label", item.get("text", ""))),
        }

    if raw_type == "checkbox":
        return {
            "type": "checkbox",
            "label": str(item.get("label", item.get("text", "Checkbox"))),
            "checked": bool(item.get("checked", False)),
        }

    if raw_type == "select":
        opts = item.get("options", ["Option 1", "Option 2"])
        if not isinstance(opts, list):
            opts = ["Option 1", "Option 2"]
        return {
            "type": "select",
            "label": str(item.get("label", item.get("text", "Select"))),
            "placeholder": str(item.get("placeholder", "Choose...")),
            "options": [str(o) for o in opts],
        }

    if raw_type == "badge":
        return {
            "type": "badge",
            "text": str(item.get("text", item.get("label", "Badge"))),
            "variant": str(item.get("variant", "accent")),
        }

    if raw_type == "stats":
        return {
            "type": "stats",
            "label": str(item.get("label", "Metric")),
            "value": str(item.get("value", "100%")),
            "change": str(item.get("change", "")) if item.get("change") else None,
        }

    if raw_type == "divider":
        return {"type": "divider"}

    # Fallback to standard text element
    text_content = str(item.get("text", item.get("label", item.get("title", ""))))
    return {
        "type": "text",
        "text": text_content if text_content else "Note",
    }


def normalize_interface_tree(data: Dict[str, Any]) -> Dict[str, Any]:
    """Validates and normalizes top-level UI data structure."""
    if not isinstance(data, dict):
        raise ValueError("Root response must be a JSON object.")

    title = str(data.get("title", "Digital Architecture UI"))
    subtitle = str(data.get("subtitle", ""))

    raw_elements = data.get("elements", [])
    if not isinstance(raw_elements, list):
        raw_elements = data.get("ordered_elements", [])

    if not isinstance(raw_elements, list):
        raw_elements = []

    cleaned_elements = []
    for item in raw_elements:
        sanitized = sanitize_element(item)
        if sanitized:
            cleaned_elements.append(sanitized)

    # Ensure there is at least one UI element
    if not cleaned_elements:
        cleaned_elements.append({
            "type": "card",
            "title": title,
            "text": subtitle or "Interface layout captured from sketch.",
            "children": [
                {"type": "button", "text": "Interactive Action", "variant": "primary"}
            ]
        })

    # Style block normalization
    raw_style = data.get("style", {})
    if not isinstance(raw_style, dict):
        raw_style = {}

    style = {
        "theme": "dark" if raw_style.get("theme", "dark") != "light" else "light",
        "glassmorphism": bool(raw_style.get("glassmorphism", True)),
        "accentColor": str(raw_style.get("accentColor", "#c5fa65")),
        "layout": str(raw_style.get("layout", "vertical")),
    }

    return {
        "title": title,
        "subtitle": subtitle,
        "style": style,
        "elements": cleaned_elements,
    }


def call_gemini_vision(image_data: str, mime: str) -> tuple[Dict[str, Any], str]:
    """
    Calls Gemini API with vision payload.
    Automatically retries candidate models if 503 (high demand) or 429 occurs.
    """
    if not API_KEY:
        raise HTTPException(
            500,
            "GEMINI_API_KEY is not set in backend/.env. Please configure your key."
        )

    last_error_msg = "Unknown error"

    for model_name in CANDIDATE_MODELS:
        api_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"

        payload = {
            "contents": [{
                "role": "user",
                "parts": [
                    {"text": PROMPT},
                    {
                        "inline_data": {
                            "mime_type": mime,
                            "data": image_data,
                        }
                    },
                ],
            }],
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": 4096,
                "responseMimeType": "application/json",
            },
        }

        try:
            response = requests.post(
                api_url,
                params={"key": API_KEY},
                json=payload,
                timeout=(8, 25),  # 8s connect, 25s read
            )
        except requests.exceptions.Timeout:
            last_error_msg = f"Request to model {model_name} timed out after 25s."
            continue
        except requests.exceptions.RequestException as exc:
            # Mask API key if accidentally in string
            clean_exc = str(exc).replace(API_KEY, "[REDACTED_API_KEY]")
            last_error_msg = f"Network connection error to Gemini ({model_name}): {clean_exc}"
            continue

        # If model is unavailable (503) or rate-limited (429) or not found (404), try fallback model
        if response.status_code in (503, 429, 404):
            try:
                err_body = response.json().get("error", {})
                last_error_msg = f"Gemini {model_name} ({response.status_code}): {err_body.get('message', response.text)}"
            except Exception:
                last_error_msg = f"Gemini {model_name} returned HTTP {response.status_code}"
            continue

        if not response.ok:
            try:
                err_data = response.json().get("error", {})
                msg = err_data.get("message", response.text)
            except Exception:
                msg = response.text
            # Clean any accidental key leak
            msg = msg.replace(API_KEY, "[REDACTED_KEY]")
            raise HTTPException(response.status_code, f"Gemini API error ({model_name}): {msg}")

        try:
            body = response.json()
        except ValueError:
            last_error_msg = f"Gemini ({model_name}) returned non-JSON response body."
            continue

        candidates = body.get("candidates", [])
        if not candidates:
            last_error_msg = f"Gemini ({model_name}) returned 0 candidates."
            continue

        candidate = candidates[0]
        parts = candidate.get("content", {}).get("parts", [])
        raw_text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))

        if not raw_text.strip():
            finish_reason = candidate.get("finishReason", "EMPTY")
            last_error_msg = f"Gemini returned empty text (finishReason: {finish_reason})"
            continue

        try:
            parsed_json = repair_and_parse_json(raw_text)
            validated_ui = normalize_interface_tree(parsed_json)
            return validated_ui, model_name
        except Exception as exc:
            last_error_msg = f"Could not parse UI structure from model {model_name}: {exc}"
            continue

    # If all candidate models failed
    raise HTTPException(
        502,
        f"Unable to analyze sketch with available Gemini models. Last error: {last_error_msg}"
    )


@app.get("/")
def home():
    return {
        "status": "online",
        "service": "SketchFlow Digital Architecture API",
        "version": "2.0.0",
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "api_key_configured": bool(API_KEY),
        "primary_model": PRIMARY_MODEL,
        "available_models": CANDIDATE_MODELS,
        "cors_origins": ALLOWED_ORIGINS,
        "cors_regex": r"^https://[a-zA-Z0-9_-]+\.onrender\.com$",
    }


@app.get("/templates")
def list_templates():
    return {
        "templates": list(DEMO_TEMPLATES.keys())
    }


@app.post("/analyze")
def analyze(req: SketchRequest):
    # Check for offline demo/test mode requests
    if req.test_mode or (req.image and req.image.startswith("demo:")):
        demo_key = req.image.replace("demo:", "").strip() if req.image and req.image.startswith("demo:") else "dashboard"
        template = DEMO_TEMPLATES.get(demo_key, DEMO_TEMPLATES["dashboard"])
        return {
            "success": True,
            "ui": template,
            "interface": template,
            "model": "offline-demo-engine",
            "is_demo": True,
        }

    # Validate image input
    image_b64, mime = parse_and_validate_image(req.image)

    # Process with Gemini Vision
    ui_data, model_used = call_gemini_vision(image_b64, mime)

    return {
        "success": True,
        "ui": ui_data,
        "interface": ui_data,
        "model": model_used,
        "is_demo": False,
    }
