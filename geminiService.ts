
import { TravelPlan, Pacing, AccommodationType } from "./types";

interface APISettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const DEFAULT_SETTINGS: APISettings = {
  apiKey: "sk-28c0d0093c2c4486ac3b394da91f7386",
  baseUrl: "https://api.grsai.com/v1/chat/completions",
  model: "gemini-3-pro"
};

function getSettings(): APISettings {
  try {
    const stored = localStorage.getItem('gemini_drive_settings');
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.warn("Failed to load settings", e);
  }
  return DEFAULT_SETTINGS;
}

async function callOpenAICompatible(messages: any[], jsonMode: boolean = true) {
  const settings = getSettings();
  const url = settings.baseUrl;

  const body: any = {
    model: settings.model,
    messages: messages,
    stream: false,
    max_tokens: 8192,
    temperature: 0.7
  };

  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API Request Failed: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    if (!content) throw new Error("Empty response from AI");
    return content;
  } catch (error: any) {
    console.error("API Call Error:", error);
    throw error;
  }
}

function extractJson(text: string): any {
  // 1. Clean Markdown Code Blocks
  let jsonString = text.trim();
  const codeBlockMatch = jsonString.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    jsonString = codeBlockMatch[1].trim();
  }

  // 2. Remove comments (single line)
  jsonString = jsonString.replace(/(^|[^:])\/\/.*$/gm, '$1');

  // 3. Heuristic: Locate Start of JSON
  const firstOpen = jsonString.search(/[\{\[]/);
  if (firstOpen !== -1) {
    jsonString = jsonString.substring(firstOpen);
  }

  // 4. Try parsing immediately
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    // If failed, proceed to repair
  }

  // 5. Repair Mechanism for Truncated JSON
  // Balance braces/brackets and remove trailing commas
  try {
    const stack: string[] = [];
    let inString = false;
    let isEscaped = false;
    let lastValidCharIndex = -1;

    for (let i = 0; i < jsonString.length; i++) {
      const char = jsonString[i];
      
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      
      if (char === '\\') {
        isEscaped = true;
        continue;
      }
      
      if (char === '"') {
        inString = !inString;
      }
      
      if (!inString) {
        if (char === '{') stack.push('}');
        else if (char === '[') stack.push(']');
        else if (char === '}' || char === ']') {
          const expected = stack[stack.length - 1];
          if (char === expected) stack.pop();
        }
        
        // Track the last non-whitespace character that isn't part of a truncated structure
        if (!/\s/.test(char)) lastValidCharIndex = i;
      }
    }

    // If we ended inside a string, close it
    if (inString) {
      jsonString += '"';
    }

    // Check for trailing comma before closing
    // A simple way is to remove trailing comma if the last meaningful char was a comma
    // But we need to be careful. Let's look at the end of the string.
    jsonString = jsonString.replace(/,\s*$/, '');

    // Close remaining containers
    while (stack.length > 0) {
      jsonString += stack.pop();
    }

    // Final cleanup: Remove trailing commas before closing braces
    // (e.g. "item", } -> "item" })
    jsonString = jsonString.replace(/,\s*([\}\]])/g, '$1');

    return JSON.parse(jsonString);
  } catch (e) {
    console.error("JSON Repair failed", e);
    console.log("Attempted string:", jsonString);
    throw new Error("AI output was incomplete or invalid. Please try reducing the number of days.");
  }
}

export async function generateTravelPlan(params: {
  start: string;
  end: string;
  startTime: string;
  endTime: string;
  days: number;
  travelers: number;
  isRoundTrip: boolean;
  pacing: Pacing;
  includeAccom: boolean;
  accommodationType: AccommodationType;
  hotelBudget: number;
  mustVisit?: string[];
  avoid?: string[];
}): Promise<TravelPlan> {
  const { start, end, startTime, endTime, days, travelers, isRoundTrip, pacing, includeAccom, accommodationType, hotelBudget, mustVisit, avoid } = params;

  // Optimized System Instruction for High-Quality, Experience-First Travel
  const systemInstruction = `You are a Senior Luxury Travel Consultant & Local Expert for China.
  
  **YOUR GOAL**: Design a "Travel Experience", NOT just a navigation route.
  **PRIORITY**: Quality of Attractions > Food Quality > Scenic Route > Distance Efficiency.

  **STRICT RULES FOR LOCATION SELECTION**:
  1.  **Must-Visit Attractions**: You MUST include National 5A/4A Tourist Attractions and city landmarks.
  2.  **Specific Store Names (CRITICAL)**:
      - **Restaurants**: DO NOT say "Local Seafood". Provide the **EXACT NAME** (Dianping Black Pearl, Michelin, or Must-Eat List).
      - **Hotels**: Provide the **EXACT NAME** of a specific hotel (e.g., "Atour S Hotel West Lake").
      - **Parking**: Provide a specific **Parking Lot Name**.
  3.  **Smart Detours & Scenic Routing**: 
      - Do not simply take the shortest highway.
  4.  **Dining Standards**: Food must be a highlight.

  **MANDATORY USER REQUIREMENTS (HIGHEST PRIORITY)**:
  ${mustVisit && mustVisit.length > 0 ? `- **MUST VISIT**: You MUST include these specific places/experiences in the itinerary: ${mustVisit.join(', ')}.` : ''}
  ${avoid && avoid.length > 0 ? `- **AVOID / BLOCK**: You MUST NOT include any of these places, brands, or areas: ${avoid.join(', ')}.` : ''}

  **SCHEDULE LOGIC**:
  1. **Timezone**: Beijing Time (UTC+8).
  2. **Trip Duration**: EXACTLY from [${startTime}] to [${endTime}].
     - **CRITICAL**: Check the Start Time hour. If starting in the afternoon/evening, DO NOT schedule morning activities for Day 1.
     - **CRITICAL**: Check the End Time hour. Ensure the last day's activities fit before the end time.
  3. **Sleep Schedule**: STRICTLY 23:00 - 08:00 (No travel or activities).

  **USER PREFERENCES**:
  1. Group Size: ${travelers} people.
  2. Pacing: ${pacing}.
  3. Accommodation: ${includeAccom ? (accommodationType === AccommodationType.HOTEL ? `Specific Hotel (Budget ~${hotelBudget} CNY). Find best value in this range.` : "Safe, specific parking lot suitable for car camping (with restrooms).") : "No accommodation needed."}
  4. Round Trip: ${isRoundTrip ? "Yes. Return route MUST be different (Loop line) to maximize scenery." : "No, one way."}
  5. Language: Simplified Chinese (简体中文).

  **OUTPUT FORMAT**:
  - Return **ONLY** valid JSON.
  - **ticket_price**: Real estimate (e.g. "¥120").
  - **average_cost**: Dining/activity cost (e.g. "¥150/人").
  - **duration**: e.g. "3小时".

  JSON Structure:
  {
    "title": "string (e.g. '广深沿海美食之旅 - 汕尾站')",
    "days": [
      {
        "day": number,
        "date": "YYYY-MM-DD",
        "transportation_cost": "string (e.g. '¥200', ESTIMATED Fuel + Highway Tolls for this day based on distance)",
        "points": [
          {
            "name": "string (Specific Business/Spot Name)",
            "type": "attraction" | "restaurant" | "parking" | "hotel",
            "arrivalTime": "HH:mm",
            "duration": "string",
            "ticket_price": "string",
            "average_cost": "string",
            "description": "string",
            "rating": number (4.0-5.0),
            "user_ratings_total": number,
            "lat": number,
            "lng": number,
            "travelTimeToNext": "string"
          }
        ]
      }
    ]
  }`;

  const userPrompt = `Design a premium ${days}-day self-driving itinerary from ${start} to ${end}. 
  Start: ${startTime}, End: ${endTime}. Travelers: ${travelers}.
  ${mustVisit && mustVisit.length > 0 ? `Include: ${mustVisit.join(', ')}` : ''}
  ${avoid && avoid.length > 0 ? `Exclude: ${avoid.join(', ')}` : ''}
  Focus on 5A/4A attractions and Dianping high-rated food. Specific store names for all stops.`;

  const responseText = await callOpenAICompatible([
    { role: "system", content: systemInstruction },
    { role: "user", content: userPrompt }
  ]);

  const data = extractJson(responseText);

  return {
    id: Date.now().toString(),
    ...params,
    startPoint: start,
    endPoint: end,
    title: data.title || `${start} - ${end} 深度自驾`,
    durationDays: days,
    days: data.days || [],
    mustVisit,
    avoid
  };
}

export async function getAlternativePoints(pointName: string, type: string): Promise<any[]> {
  const systemInstruction = `You are a travel assistant. Find 5 alternative **Top-Tier** (>4.5 rating) places for "${pointName}" of type "${type}". 
  
  Rules:
  1. If type is 'restaurant', candidates MUST be on Dianping Must-Eat List, Black Pearl, or Michelin.
  2. If type is 'attraction', candidates MUST be 5A/4A or trending internet-famous spots.
  3. Output **Exact Business Names**.

  Language: Simplified Chinese (简体中文).
  Output **ONLY** JSON Array: [{"name", "rating", "user_ratings_total", "description", "lat", "lng", "ticket_price", "average_cost", "duration"}]`;

  const responseText = await callOpenAICompatible([
    { role: "system", content: systemInstruction },
    { role: "user", content: "Find premium alternatives. Return JSON." }
  ]);

  const data = extractJson(responseText);
  return Array.isArray(data) ? data : (data.alternatives || []);
}

export async function recommendDestinations(currentLocation: string): Promise<string[]> {
  const systemInstruction = `Recommend 5 **High-Quality** self-driving destinations >300km from ${currentLocation}.
  Focus on 5A scenic areas, historical cities, or unique landscapes.
  Language: Simplified Chinese (简体中文).
  Output **ONLY** JSON Array of strings: ["City1", "City2", ...]`;

  const responseText = await callOpenAICompatible([
    { role: "system", content: systemInstruction },
    { role: "user", content: "Recommend scenic destinations. Return JSON." }
  ]);

  const data = extractJson(responseText);
  return Array.isArray(data) ? data : [];
}
