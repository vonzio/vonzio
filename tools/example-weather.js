// Example custom tool: Get weather information
// This demonstrates the tool file format for vonzio.
//
// Tool files must export: name, description, inputSchema, handler
// The handler receives args matching inputSchema and must return
// { content: [{ type: "text", text: "..." }] }

module.exports = {
  name: "get_weather",
  description: "Get current weather information for a city. Returns simulated weather data for demonstration purposes.",
  inputSchema: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "City name (e.g., 'San Francisco', 'London')",
      },
      units: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "Temperature units",
        default: "celsius",
      },
    },
    required: ["city"],
  },
  handler: async (args) => {
    // Simulated weather data for demonstration
    const temp = Math.floor(Math.random() * 30) + 5;
    const conditions = ["sunny", "cloudy", "rainy", "partly cloudy", "windy"][
      Math.floor(Math.random() * 5)
    ];
    const humidity = Math.floor(Math.random() * 60) + 30;

    const tempDisplay =
      args.units === "fahrenheit"
        ? `${Math.round(temp * 1.8 + 32)}F`
        : `${temp}C`;

    const result = {
      city: args.city,
      temperature: tempDisplay,
      conditions,
      humidity: `${humidity}%`,
      note: "This is simulated data from the example-weather tool.",
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
};
