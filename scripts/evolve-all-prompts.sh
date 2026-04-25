#!/usr/bin/env bash

# Launch a massive multi-day prompt evolution suite on fornace.net
#
# This script queues three deep-search optimization runs for the three most
# complex, structural prompts in claude-overnight.
#
# It uses the optimal Google model mix:
# - gemini-3.1-flash-lite-preview (Evaluator: ~1,500 incredibly fast API calls per run)
# - gemini-3.1-pro-preview (Mutator: deep reasoning to invent new prompt variants)
#
# To run this, you need your fnc_... token from fornace.net and your Google API key.
#
# Usage:
#   ./scripts/evolve-all-prompts.sh <PROJECT_ID> <FNC_TOKEN> <GOOGLE_API_KEY>

PROJECT_ID=$1
FNC_TOKEN=$2
GOOGLE_API_KEY=$3

if [ -z "$PROJECT_ID" ] || [ -z "$FNC_TOKEN" ] || [ -z "$GOOGLE_API_KEY" ]; then
  echo "Usage: ./scripts/evolve-all-prompts.sh <PROJECT_ID> <FNC_TOKEN> <GOOGLE_API_KEY>"
  exit 1
fi

echo "🚀 Queuing deep search for '10-3_plan' (The Task Splitter)..."
curl -s -X POST "https://fornace.net/api/projects/${PROJECT_ID}/prompt-evolution/enqueue" \
  -H "Authorization: Bearer ${FNC_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "claude-overnight",
    "prompt": "10_planning/10-3_plan",
    "cases": "plan",
    "evalModel": "gemini-3.1-flash-lite-preview",
    "mutateModel": "gemini-3.1-pro-preview",
    "generations": 50,
    "population": 12,
    "plateau": 6,
    "reps": 3,
    "env": {
      "ANTHROPIC_BASE_URL": "https://generativelanguage.googleapis.com/v1beta/openai/",
      "ANTHROPIC_API_KEY": "'"${GOOGLE_API_KEY}"'"
    }
  }' | jq .

echo ""
echo "🚀 Queuing deep search for '30-1_steer' (The Loop Controller)..."
curl -s -X POST "https://fornace.net/api/projects/${PROJECT_ID}/prompt-evolution/enqueue" \
  -H "Authorization: Bearer ${FNC_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "claude-overnight",
    "prompt": "30_wave/30-1_steer",
    "cases": "steer",
    "evalModel": "gemini-3.1-flash-lite-preview",
    "mutateModel": "gemini-3.1-pro-preview",
    "generations": 50,
    "population": 12,
    "plateau": 6,
    "reps": 3,
    "env": {
      "ANTHROPIC_BASE_URL": "https://generativelanguage.googleapis.com/v1beta/openai/",
      "ANTHROPIC_API_KEY": "'"${GOOGLE_API_KEY}"'"
    }
  }' | jq .

echo ""
echo "🚀 Queuing deep search for '00-1_coach' (The Initial Brain)..."
curl -s -X POST "https://fornace.net/api/projects/${PROJECT_ID}/prompt-evolution/enqueue" \
  -H "Authorization: Bearer ${FNC_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "claude-overnight",
    "prompt": "00_setup/00-1_coach",
    "cases": "coach",
    "evalModel": "gemini-3.1-flash-lite-preview",
    "mutateModel": "gemini-3.1-pro-preview",
    "generations": 50,
    "population": 12,
    "plateau": 6,
    "reps": 3,
    "env": {
      "ANTHROPIC_BASE_URL": "https://generativelanguage.googleapis.com/v1beta/openai/",
      "ANTHROPIC_API_KEY": "'"${GOOGLE_API_KEY}"'"
    }
  }' | jq .

echo ""
echo "✅ All jobs enqueued on fornace.net."
echo "Keep track of the runIds printed above."
echo ""
echo "To monitor them remotely from your laptop, run:"
echo "  npx claude-overnight-evolve download <RUN_ID> --base-url https://fornace.net --token ${FNC_TOKEN} --project ${PROJECT_ID} --watch"
