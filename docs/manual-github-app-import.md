# Manually Import a GitHub App into Orbit/torbit

When you can't use the manifest flow (e.g., GitHub Enterprise with personal account restrictions), you can manually create the app and import the credentials using Orbit's API.

## Quick Start (Recommended)

After building torbit with patch `0004-feat-manual-github-app-registration.patch`:

```powershell
# 1. Create the GitHub App manually on GHES
#    Navigate to: https://mercedes-benz.ghe.com/settings/apps/new

# 2. Call the API to register it in Orbit
$workspaceId = "your-workspace-id"

# Prepare the request body
$body = @{
    app_id = 123456
    slug = "orbit"
    private_key = Get-Content "C:\Temp\private-key.pem" -Raw
    webhook_secret = "your-webhook-secret"
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Method Post `
    -Uri "https://s040dfciiot01.de040.corpintra.net/api/v1/workspaces/$workspaceId/github/manual-registration" `
    -Headers @{
        "Cookie" = "orbit-session=your-session-token"
        "Content-Type" = "application/json"
    } `
    -Body $body
```

**Note**: You need to be authenticated as a workspace owner/admin. Use your browser's session cookie or an API token.

## Prerequisites

1. **Build torbit with patch 0004** - This adds the manual registration endpoint
2. **Create the GitHub App manually** (see Step 1 below)

## Step 1: Create the GitHub App Manually

Navigate to GitHub and create the app with these settings:

**URL**: `https://mercedes-benz.ghe.com/settings/apps/new`

### Configuration

| Field | Value |
|-------|-------|
| **GitHub App name** | `Orbit` (or your preferred name) |
| **Homepage URL** | `https://s040dfciiot01.de040.corpintra.net` |
| **Callback URL** | Leave empty (not used for integrations) |
| **Webhook URL** | `https://s040dfciiot01.de040.corpintra.net/api/v1/integrations/github/webhook` |
| **Webhook active** | ✅ Active |
| **Webhook secret** | Generate a random string (save it!) |

### Permissions

| Permission | Access Level |
|------------|--------------|
| **Issues** | Read-only |
| **Pull requests** | Read-only |

### Subscribe to Events

- ✅ Issues
- ✅ Pull request

### Where can this GitHub App be installed?

- **Only on this account** (or your organization)

### After Creation

1. Note the **App ID** (e.g., `123456`)
2. Note the **App slug** (the URL-friendly name)
3. Generate a **Private key** (.pem file) and download it
4. Save the **Webhook secret** you created

## Step 2: Register via API

After creating the GitHub App, call Orbit's manual registration endpoint:

```powershell
# Get your session token (from browser developer tools)
# Or use Basic auth / API token if configured

# Prepare the request body
$body = @{
    app_id = 123456                    # From GitHub App settings
    slug = "orbit"                      # From GitHub App settings
    private_key = Get-Content "C:\Temp\private-key.pem" -Raw
    webhook_secret = "your-webhook-secret"
} | ConvertTo-Json -Depth 10

# Set your workspace ID (get from Orbit URL or API)
$workspaceId = "your-workspace-id"

# Call the API (with your session cookie)
$response = Invoke-RestMethod `
    -Method Post `
    -Uri "https://s040dfciiot01.de040.corpintra.net/api/v1/workspaces/$workspaceId/github/manual-registration" `
    -Headers @{
        "Cookie" = "orbit-session=your-session-token"
        "Content-Type" = "application/json"
    } `
    -Body $body

Write-Host "GitHub App registered: $($response)"
```

### API Request Format

```
POST /api/v1/workspaces/{workspace_id}/github/manual-registration
Content-Type: application/json

{
    "app_id": 123456,
    "slug": "orbit",
    "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
    "webhook_secret": "your-webhook-secret"
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `app_id` | number | GitHub App ID from the app's About section |
| `slug` | string | URL-friendly app name from the app's About section |
| `private_key` | string | PEM-formatted private key (download from GitHub) |
| `webhook_secret` | string | Secret you configured in webhook settings |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `generate_webhook_secret` | boolean | Auto-generate webhook secret (use if you don't know the existing one) |

## Step 3: Install the App

After importing, install the app on your repositories:

1. Navigate to: `https://mercedes-benz.ghe.com/apps/orbit/installations/new`
2. Select repositories to grant access
3. GitHub will send an `installation` webhook to Orbit

## Step 4: Connect Projects

In Orbit:
1. Go to **Settings → GitHub**
2. Select a project and connect it to a repository with a label

## Troubleshooting

### App not showing up

```powershell
# Check if app is in database
sqlite3 "C:\ProgramData\Torbit\data\orbit.sqlite" "SELECT * FROM github_apps;"

# Check installations (should populate after you install the app)
sqlite3 "C:\ProgramData\Torbit\data\orbit.sqlite" "SELECT * FROM github_installations;"

# Check repositories
sqlite3 "C:\ProgramData\Torbit\data\orbit.sqlite" "SELECT * FROM github_installation_repositories;"
```

### Webhook errors

Check Orbit logs:

```powershell
Get-Content "C:\ProgramData\Torbit\logs\orbit.log" -Tail 100 | Select-String "github"
```

Common issues:
- **Wrong webhook URL**: Ensure it's `{origin}/api/v1/integrations/github/webhook`
- **Wrong webhook secret**: Make sure it matches what's configured in GitHub
- **GitHub host mismatch**: Verify `torbit_github_host_binding` matches your `ORBIT_GITHUB_URL`

### Encryption errors

If Orbit can't decrypt the credentials:
- Verify the app.key file matches what Orbit was started with
- Check that the .pem file is the correct one for your app
- Ensure the webhook secret matches exactly

## Security Notes

1. **Keep your app key safe** - Without it, all encrypted secrets are lost
2. **Webhook secret** - Should be a strong random string
3. **Private key** - Store the .pem file securely; you can regenerate it on GitHub if needed
4. **API authentication** - Only workspace owners/admins can register GitHub Apps
