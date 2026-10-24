// Web Bluetooth link to the Sleep Sheep. This tab holds the connection; the server sends command text
// over Server-Sent Events, and this tab writes it to the sheep and reports status back.
// Works in Chrome/Edge on desktop and Android, and in the Bluefy browser on iPhone (Safari has no Web Bluetooth).

const enc = new TextEncoder();
const dec = new TextDecoder();

async function post(url, body) {
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    // server unreachable: it will show the sheep as disconnected
  }
}

export class SheepBluetooth {
  constructor() {
    this.device = null;
    this.cmd = null;
    this.events = null;
    this.queue = Promise.resolve();
    this.onChange = () => {};
  }

  get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get connected() {
    return !!this.device?.gatt?.connected;
  }

  /** Must run from a click: the browser shows its device picker, filtered to the sheep's service. */
  async connect(ids) {
    if (!this.supported) throw new Error('This browser has no Web Bluetooth. Use Chrome or Edge on a laptop or Android, or the Bluefy browser on iPhone.');
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [ids.service] }] });
    device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(ids.service);
    this.cmd = await svc.getCharacteristic(ids.command);
    const status = await svc.getCharacteristic(ids.status);
    status.addEventListener('characteristicvaluechanged', (e) => post('/api/sheep/ble/status', { raw: dec.decode(e.target.value) }));
    await status.startNotifications();
    post('/api/sheep/ble/status', { raw: dec.decode(await status.readValue()) });
    this.device = device;
    this.events?.close();
    this.events = new EventSource('/api/sheep/ble/commands');
    this.events.onmessage = (m) => this.write(JSON.parse(m.data));
    await post('/api/sheep/ble/connection', { connected: true, name: device.name });
    this.onChange();
  }

  /** GATT allows one operation at a time, so writes are queued. */
  write({ id, text }) {
    this.queue = this.queue.then(async () => {
      try {
        if (!this.cmd || !this.connected) throw new Error('Sheep not connected over Bluetooth');
        await this.cmd.writeValueWithResponse(enc.encode(String(text).slice(0, 40)));
        await post('/api/sheep/ble/ack', { id, ok: true });
      } catch (e) {
        await post('/api/sheep/ble/ack', { id, ok: false, error: e.message });
      }
    });
  }

  handleDisconnect() {
    this.events?.close();
    this.events = null;
    this.cmd = null;
    post('/api/sheep/ble/connection', { connected: false });
    this.onChange();
  }

  disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.handleDisconnect();
  }
}
