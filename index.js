const fs = require('fs').promises;
const dns = require('dns').promises;
const net = require('net');
const https = require('https');
const fetch = require('node-fetch');
const config = require('./config.json');
const {cf, ros} = config;
const {cfZoneId, cfDomainId, cfDomainName, cfDomainTtl, cfAuthEmail, cfAuthKey} = cf;
const {rosHost, rosUser, rosPass} = ros;
const agent = new https.Agent({
  rejectUnauthorized: false,
});

const cache = {};
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
  // ROS REST API 不支持 HTTP，一定要走 HTTPS
  url = `https://${rosHost}/rest${url}`;
  const options = {
    method, agent,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${rosUser}:${rosPass}`).toString('base64'),
      'Content-Type': 'application/json'
    }
  }

  if (body) {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(url, options);
  return resp.json();
}

async function updateDdns(ip) {
  const body = {
    content: ip,
    name: cfDomainName,
    proxied: false,
    ttl: cfDomainTtl,
    type: 'A'
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

    console.log(`Current gateway: ${gateway}, current address: ${addr}`);

    const routes = await queryRouterOS({url: '/ip/route'});

    // build up routes and cache
    for (const name in peers) {
      const peerHost = peers[name];
      let peerAddr = net.isIP(peerHost) ? peerHost : ((await dns.lookup(peerHost))['address']); // get peer ip

      if (!cache[name]) {
        cache[name] = {
          routeId: null,
          'dst-address': peerAddr
        }
      }

      let hasPeerRoute = false;
      for (const route of routes) {
        if (route['comment'] === name) {
          hasPeerRoute = true;
          const routeId = route['.id']
          cache[name]['routeId'] = routeId;
          cache[name]['dst-address'] = peerAddr;
          route['dst-address'] = route['dst-address'].replace(/\/\d\d/, '');
          if (route['gateway'] !== gateway || route['dst-address'] !== peerAddr) {
            await patchPeerRoute({routeId, peerAddr, gateway});
          }
          break;
        }
      }

      if (!hasPeerRoute) {
        const resp = await addPeerRoute({peerAddr, gateway, comment: name});
        console.log(resp);
        cache[name] = {
          'dst-address': peerAddr,
          routeId: resp['.id']
        }
        console.log(`No route for ${name}, added: ${JSON.stringify(cache[name])}`);
      }
    }

    // update routes
    if (lastGateway !== gateway) {
      for (const name in cache) {
        const {routeId} = cache[name];
        const data = await patchPeerRoute({routeId, gateway});
        console.log(`Update route ${name}: ${JSON.stringify(data)}`);
      }
    }

    if (addr !== lastAddr) {
      console.log(`IP changed, last address: ${lastAddr}, current address: ${addr}`);
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
    console.log(`Next update in ${watchInterval} seconds`);
    setTimeout(run, watchInterval * 1000);
  }

  await run();

})();
