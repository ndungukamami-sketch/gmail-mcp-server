import { getAuthenticatedClient } from './dist/auth/oauth.js';

getAuthenticatedClient()
  .then(() => { console.log('Auth complete!'); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });