import sys
import base64
from pathlib import Path

# Add backend directory to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from main import (
    app,
    health,
    repair_and_parse_json,
    normalize_interface_tree,
    parse_and_validate_image,
    analyze,
    SketchRequest,
)

def run_tests():
    print("=== TEST 1: Health Check ===")
    h = health()
    print("Health result:", h)
    assert h["status"] == "ok"
    assert h["api_key_configured"] is True
    print("PASS: Health Check\n")

    print("=== TEST 2: JSON Repair & Markdown Stripping ===")
    markdown_json = '''```json
    {
      "title": "Mobile Banking",
      "style": {"glassmorphism": true, "theme": "dark"},
      "elements": [
        {"type": "heading", "text": "Accounts Overview"},
        {"type": "row", "children": [
          {"type": "card", "title": "Checking", "text": "$4,250.00"},
          {"type": "card", "title": "Savings", "text": "$18,900.50"}
        ]}
      ]
    }
    ```'''
    parsed = repair_and_parse_json(markdown_json)
    normalized = normalize_interface_tree(parsed)
    assert normalized["title"] == "Mobile Banking"
    assert len(normalized["elements"]) == 2
    assert normalized["elements"][1]["type"] == "row"
    assert len(normalized["elements"][1]["children"]) == 2
    print("PASS: JSON Repair\n")

    print("=== TEST 3: Demo / Test Mode Analyze ===")
    demo_req = SketchRequest(image="demo:dashboard", test_mode=True)
    res = analyze(demo_req)
    assert res["success"] is True
    assert "ui" in res
    assert "interface" in res
    assert res["ui"]["title"] == "Cloud Analytics Hub"
    print("PASS: Demo Mode\n")

    print("=== TEST 4: Live Gemini Vision Analysis with Real Image ===")
    hero_path = Path(__file__).resolve().parent.parent / "frontend" / "src" / "assets" / "hero.png"
    if hero_path.exists():
        with open(hero_path, "rb") as f:
            b64_img = "data:image/png;base64," + base64.b64encode(f.read()).decode("utf-8")
        req = SketchRequest(image=b64_img)
        res = analyze(req)
        print("Live analysis model used:", res["model"])
        print("Live analysis UI title:", res["ui"]["title"])
        print("Live analysis UI elements count:", len(res["ui"]["elements"]))
        print("PASS: Live Vision Analysis\n")
    else:
        print("SKIPPED: hero.png not found")

    print("ALL BACKEND UNIT TESTS PASSED!")

if __name__ == "__main__":
    run_tests()
