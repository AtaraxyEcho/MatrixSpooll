# UI follow-ups

This backlog records UI work intentionally left outside the top-bar pass.

## Deferred

- Add an account menu and explicit log-out action to every authenticated surface.
- Decide how the account identity should be restored after a page refresh. The current client restores the token but not the username.
- Align explicit log-out and 401 expiry handling so both paths clear the same client state and show the same transition to the login page.
- Define the expected behavior for the log-out action when authentication is disabled in development mode.
- Review the settings and asset-library body layouts separately from their top bars, including local navigation density and narrow-screen content flow.
- Run a viewport and keyboard-accessibility pass over all authenticated routes after the account menu exists.
