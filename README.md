# homebridge-powershades

[![npm version](https://badge.fury.io/js/homebridge-powershades.svg)](https://badge.fury.io/js/homebridge-powershades)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [Homebridge](https://homebridge.io) plugin for [PowerShades](https://powershades.com) motorized window coverings. Control your PowerShades shades through Apple HomeKit.

## Features

- 🚀 **Fast & Responsive**: HTTP keep-alive connections for 20-30% faster API calls
- 💾 **Smart Caching**: Reduces unnecessary API calls with intelligent shade list caching
- 📊 **Adaptive Polling**: 1-second polling when active, 10-second when idle
- 🎨 **Easy Configuration**: Custom UI for easy setup through Homebridge Config UI X
- 🏠 **Full HomeKit Integration**: Control shades via Siri, Home app, and automations

## Installation

### Option 1: Via Homebridge Config UI X (Recommended)

1. Search for `homebridge-powershades` in the Homebridge Config UI X plugins tab
2. Click **Install**
3. Configure with your PowerShades account credentials

### Option 2: Via npm

```bash
npm install -g homebridge-powershades
```

## Configuration

Configure the plugin through the Homebridge Config UI X interface, or manually edit your `config.json`.

### Authentication

You can authenticate using **either** an API token (recommended) or your email/password:

**Option 1: API Token (Recommended)**

More secure - doesn't store your password. Get your API token from the PowerShades dashboard:
1. Go to [PowerShades Dashboard](https://dashboard.powershades.com)
2. Click your name (top right)
3. Click "My Account"
4. Under "Authorized Applications", click "Get New API Token"

```json
{
  "platforms": [
    {
      "platform": "PowerShades",
      "name": "PowerShades",
      "apiToken": "your-api-token-here",
      "pollInterval": 10,
      "fastPollInterval": 1,
      "fastPollDuration": 30,
      "shadeListCacheTTL": 300
    }
  ]
}
```

**Option 2: Email and Password**

```json
{
  "platforms": [
    {
      "platform": "PowerShades",
      "name": "PowerShades",
      "email": "your@email.com",
      "password": "your-password",
      "pollInterval": 10,
      "fastPollInterval": 1,
      "fastPollDuration": 30,
      "shadeListCacheTTL": 300
    }
  ]
}
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `apiToken` | *optional* | Your PowerShades API token (recommended) |
| `email` | *optional* | Your PowerShades account email (if not using apiToken) |
| `password` | *optional* | Your PowerShades account password (if not using apiToken) |
| `pollInterval` | `10` | Polling interval in seconds when idle (2-60) |
| `fastPollInterval` | `1` | Polling interval in seconds after activity (1-5) |
| `fastPollDuration` | `30` | How long to use fast polling after activity (5-120) |
| `shadeListCacheTTL` | `300` | How long to cache shade list in seconds (60-3600) |
| `baseUrl` | `https://api.powershades.com` | Custom API endpoint (optional) |

## How It Works

The plugin:
1. Logs into your PowerShades cloud account
2. Discovers all shades configured in your account
3. Exposes each shade as a HomeKit `WindowCovering` accessory
4. Polls the cloud API to sync shade positions
5. Uses adaptive polling for responsive updates after user actions

## Performance Optimizations

- **HTTP Keep-Alive**: Reuses connections for 20-30% faster API calls
- **Intelligent Caching**: Caches shade list to reduce API overhead
- **Adaptive Polling**: Fast polling (1s) after activity, slower (10s) when idle
- **Smart Updates**: Only refreshes when needed, reducing cloud API load

## Supported Features

✅ Open/Close shades
✅ Set specific position (0-100%)
✅ Current position feedback
✅ Multiple shades
✅ Optimistic updates

❌ Stop command (not supported by API)
❌ Local RF control (see [RF-PROTOCOL.md](RF-PROTOCOL.md))

## Known Limitations

- **Multi-Property Accounts**: The plugin has not been tested with accounts that have multiple properties configured in the PowerShades dashboard. It currently uses the account token and displays whatever shades the API returns. If you have multiple properties and encounter issues, please [open an issue](https://github.com/apumapho/homebridge-powershades/issues).

## Development

### Testing

See [tests/README.md](tests/README.md) for development testing instructions.

### Local Development

```bash
# Clone the repository
git clone https://github.com/apumapho/homebridge-powershades.git
cd homebridge-powershades

# Install dependencies
npm install

# Link for local testing
npm link

# Run Homebridge in debug mode
homebridge -D
```

## Troubleshooting

### Shades not appearing in HomeKit

1. Check Homebridge logs for errors
2. Verify your PowerShades credentials are correct
3. Ensure your shades are configured in the PowerShades app
4. Try restarting Homebridge

### Slow response times

- Check your internet connection
- Verify the PowerShades cloud service is operational
- Adjust `fastPollInterval` for quicker responses after commands

### Plugin not loading

- Ensure Node.js 18+ is installed (required for native `fetch`)
- Check that Homebridge is version 1.6.0 or higher
- Review Homebridge logs for specific error messages

## About PowerShades

[PowerShades](https://powershades.com) manufactures battery-powered motorized window shades with RF control and cloud connectivity. This plugin uses the PowerShades cloud API to integrate with HomeKit.

## License

MIT License - see [LICENSE](LICENSE) file for details

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments

- Thanks to the [Homebridge](https://homebridge.io) team for the excellent platform
- Thanks to PowerShades for providing a cloud API
- Thanks to [Claude Code](https://claude.com/claude-code) for the vibe code assist

## Support

- 🐛 [Report Issues](https://github.com/apumapho/homebridge-powershades/issues)
- 💬 [Homebridge Discord](https://discord.gg/homebridge)
- 📖 [Homebridge Wiki](https://github.com/homebridge/homebridge/wiki)

---

Made with ❤️ for the Homebridge community
