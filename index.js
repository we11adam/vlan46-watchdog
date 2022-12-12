const fs = require('fs').promises;
const config = require('./config.json');
const {cf, ros} = config;
const {cfZoneId, cfDomainId, cfDomainName, cfDomainTtl, cfAuthEmail, cfAuthKey} = cf;
const {rosHost, rosUser, rosPass} = ros;

const fetch = require('node-fetch');
const dns = require('dns').promises;
const https = require('https');
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const lastCache = {};
let lastGateway = null;
let lastAddr = null;

async function patchPeerRoute({routeId, peerAddr, gateway}) {
  const body = {};
  if (peerAddr) {
    body['dst-address'] = peerAddr;
  }
  if (gateway) {
    body.gateway = gateway;
  }
  return queryRouterOS({
    url: `/ip/route/${routeId}`,
    method: 'PATCH',
    body
  })
}

async function addPeerRoute({peerAddr, gateway, comment}) {
  const body = {
    gateway, comment,
    'dst-address': peerAddr,
  }
  return queryRouterOS({
    url: `/ip/route`,
    method: 'PUT',
    body
  })
}

async function queryRouterOS({url, method = 'GET', body}) {
  url = `https://${rosHost}/rest${url}`;
  const options = {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${rosUser}:${rosPass}`).toString('base64'),
      'Content-Type': 'application/json'
    },
    agent: httpsAgent
  }

  if (body) {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(url, options);
  return resp.json();
}

async function updateDdns(ip) {
  const body = {
    "content": ip,
    "name": cfDomainName,
    "proxied": false,
    "ttl": cfDomainTtl,
    "type": "A"
  }
  return fetch(`https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records/${cfDomainId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Email': cfAuthEmail,
      'X-Auth-Key': cfAuthKey
    },
    body: JSON.stringify(body)
  });
}

(async () => {
  const update = async () => {
    let content = await fs.readFile('./config.json', 'utf8');
    const {peers} = JSON.parse(content);
    let dhcpClient;
    try {
      dhcpClient = (await queryRouterOS({url: '/ip/dhcp-client'}))[0];
    } catch (e) {
      console.error(`Failed to query dhcp client`);
      return;
    }
    let gateway;
    try {
      gateway = dhcpClient['gateway'];
    } catch (e) {
      console.error(`Failed to get gateway`);
      return;
    }
    let addr;
    try {
      addr = dhcpClient['address'].replace(/\/\d\d/, '');
    } catch (e) {
      console.error(`Failed to get address`);
      return;
    }
    console.log(`currentGateway: ${gateway}, currentIp: ${addr}`);

    const routes = await queryRouterOS({url: '/ip/route'});

    // build up routes and cache
    for (const name in peers) {
      const peerHost = peers[name];
      let peerAddr = (await dns.lookup(peerHost))['address']; // get peer ip

      if (!lastCache[name]) {
        lastCache[name] = {
          routeId: null,
          'dst-address': peerAddr
        }
      }

      let hasPeerRoute = false;
      for (const route of routes) {
        if (route['comment'] === name) {
          hasPeerRoute = true;
          const routeId = route['.id']
          lastCache[name]['routeId'] = routeId;
          lastCache[name]['dst-address'] = peerAddr;
          route['dst-address'] = route['dst-address'].replace(/\/\d\d/, '');
          if (route['gateway'] !== gateway || route['dst-address'] !== peerAddr) {
            await patchPeerRoute({routeId, peerAddr, gateway})
          }
          break;
        }
      }

      if (!hasPeerRoute) {
        const resp = await addPeerRoute({peerAddr, gateway, comment: name});
        console.log(resp);
        lastCache[name] = {
          'dst-address': peerAddr,
          routeId: resp['.id']
        }
        console.log(`No route for ${name}, added: ${JSON.stringify(lastCache[name])}`);
      }
    }

    // update routes
    if (lastGateway !== gateway) {
      for (const name in lastCache) {
        const {routeId} = lastCache[name];
        const data = await patchPeerRoute({routeId, gateway});
        console.log(`Update route ${name}: ${JSON.stringify(data)}`);
      }
    }

    if (addr !== lastAddr) {
      console.log(`IP changed, lastAddress: ${lastAddr}, currentAddress: ${addr}`);
      const resp = await updateDdns(addr);
      if (resp.ok) {
        console.log(`IP updated successfully: ${addr}`);
      } else {
        console.log(`Failed to update IP: ${addr}`);
        return;
      }
    }

    lastGateway = gateway;
    lastAddr = addr;
  }

  const run = async () => {
    let content = await fs.readFile('./config.json', 'utf8');
    const {watchInterval} = JSON.parse(content);
    try {
      await update();
    } catch (e) {
      console.error(e);
    }
    setTimeout(run, watchInterval * 1000);
  }

  await run();

})();
