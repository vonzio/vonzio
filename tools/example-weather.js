// Example custom tool: current weather via Open-Meteo.
//
// Demonstrates the vonzio tool file format with a REAL HTTP call (no fake
// data). A tool file exports: name, description, inputSchema, and an async
// handler. The handler receives args matching inputSchema and returns
// { content: [{ type: "text", text: "..." }] }.
//
// Open-Meteo (https://open-meteo.com) is free and needs NO API key. We
// geocode the city name to coordinates, then read the current conditions.
// (If your deployment restricts agent egress, allow geocoding-api.open-meteo.com
// and api.open-meteo.com — otherwise the tool returns a friendly error.)

// WMO weather interpretation codes → human-readable conditions.
const WMO_CONDITIONS = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "depositing rime fog",
  51: "light drizzle", 53: "moderate drizzle", 55: "dense drizzle",
  56: "light freezing drizzle", 57: "dense freezing drizzle",
  61: "slight rain", 63: "moderate rain", 65: "heavy rain",
  66: "light freezing rain", 67: "heavy freezing rain",
  71: "slight snow", 73: "moderate snow", 75: "heavy snow", 77: "snow grains",
  80: "slight rain showers", 81: "moderate rain showers", 82: "violent rain showers",
  85: "slight snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with slight hail", 99: "thunderstorm with heavy hail",
};

module.exports = {
  name: "get_weather",
  description:
    "Get the current weather for a city using the free, no-API-key Open-Meteo service. " +
    "Returns temperature, feels-like, conditions, humidity, and wind.",
  inputSchema: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "City name (e.g., 'San Francisco', 'London').",
      },
      units: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "Temperature units.",
        default: "celsius",
      },
    },
    required: ["city"],
  },
  handler: async (args) => {
    const fahrenheit = args.units === "fahrenheit";
    const tempUnit = fahrenheit ? "fahrenheit" : "celsius";
    const windUnit = fahrenheit ? "mph" : "kmh";
    const text = (t) => ({ content: [{ type: "text", text: t }] });

    // 1. Geocode the city name → coordinates (keyless).
    let geo;
    try {
      const res = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(args.city)}&count=1&language=en&format=json`,
      );
      if (!res.ok) return text(`Weather lookup failed: geocoding returned HTTP ${res.status}.`);
      geo = await res.json();
    } catch (err) {
      return text(`Weather lookup failed: could not reach the geocoding service (${err.message}).`);
    }
    const place = geo.results && geo.results[0];
    if (!place) return text(`No city found matching "${args.city}". Try a more specific name.`);

    // 2. Current conditions at those coordinates (keyless).
    let wx;
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
        `&temperature_unit=${tempUnit}&wind_speed_unit=${windUnit}`;
      const res = await fetch(url);
      if (!res.ok) return text(`Weather lookup failed: forecast returned HTTP ${res.status}.`);
      wx = await res.json();
    } catch (err) {
      return text(`Weather lookup failed: could not reach the forecast service (${err.message}).`);
    }

    const cur = wx.current || {};
    const unit = wx.current_units || {};
    const result = {
      city: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
      temperature: `${Math.round(cur.temperature_2m)}${unit.temperature_2m || (fahrenheit ? "°F" : "°C")}`,
      feels_like: `${Math.round(cur.apparent_temperature)}${unit.apparent_temperature || (fahrenheit ? "°F" : "°C")}`,
      conditions: WMO_CONDITIONS[cur.weather_code] ?? `weather code ${cur.weather_code}`,
      humidity: `${cur.relative_humidity_2m}${unit.relative_humidity_2m || "%"}`,
      wind: `${Math.round(cur.wind_speed_10m)} ${unit.wind_speed_10m || windUnit}`,
      observed_at: cur.time,
      source: "open-meteo.com (no API key required)",
    };
    return text(JSON.stringify(result, null, 2));
  },
};
