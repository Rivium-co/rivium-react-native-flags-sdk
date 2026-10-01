# Changelog

## 0.2.0

Breaking release. See the README for the short migration from 0.1.x.

- Flags are evaluated on the Rivium Flags server for your user; targeting rules are no longer sent to the app.
- Typed getters with a reason for every value.
- Anonymous id per install, so percentage rollouts also work for signed-out users.
- Offline cache, refresh on app resume, and retries that respect rate limits.
- React hooks re-render when values change. `@react-native-community/netinfo` is no longer needed.

## 0.1.0

- Initial release.
