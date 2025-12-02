# API Test Scripts

These scripts are for testing the PowerShades API integration during development.

## Setup

Set your PowerShades credentials as environment variables before running the scripts:

```bash
# For email/password authentication tests
export POWERSHADES_EMAIL="your-email@example.com"
export POWERSHADES_PASSWORD="your-password"

# Or using username variable name
export POWERSHADES_USERNAME="your-email@example.com"
export POWERSHADES_PASSWORD="your-password"

# For API token authentication tests
export POWERSHADES_API_TOKEN="your-api-token"

# Optional: custom base URL
export POWERSHADES_BASE_URL="https://api.powershades.com"
```

## Running Scripts

```bash
# Basic API smoke test (requires POWERSHADES_USERNAME and POWERSHADES_PASSWORD)
node api-test-scripts/test_powershades_api.js

# Test specific endpoints (requires POWERSHADES_EMAIL and POWERSHADES_PASSWORD)
node api-test-scripts/test_api_endpoints.js

# Test API response times (requires POWERSHADES_EMAIL and POWERSHADES_PASSWORD)
node api-test-scripts/test_api_speed.js

# Test API token authentication (requires POWERSHADES_API_TOKEN)
node api-test-scripts/test_api_token.js

# Test dashboard API (requires POWERSHADES_API_TOKEN)
node api-test-scripts/test_dashboard_api.js
```

## Note

**These scripts require environment variables to be set before running.** Never commit credentials to the repository.
