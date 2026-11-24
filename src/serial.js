// Web Serial transport: a USB-serial adapter (or a balance with a USB-CDC
// port) seen from the browser. Works in Chrome, Edge and Opera on desktop.

export const webSerialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

// Common USB-serial chips, to give ports a friendlier name.
const VENDORS = {
  0x0403: 'FTDI',
  0x067b: 'Prolific',
  0x10c4: 'Silicon Labs CP210x',
  0x1a86: 'WCH CH340',
  0x04d8: 'Microchip',
  0x2341: 'Arduino',
  0x0557: 'ATEN',
  0x05ad: 'Y.C. Cable',
};

export function portLabel(port) {
  const info = port?.getInfo?.() ?? {};
  if (info.usbVendorId === undefined) return 'Porta serial';
  const hex = (n) => n.toString(16).toUpperCase().padStart(4, '0');
  const vendor = VENDORS[info.usbVendorId];
  const id = `${hex(info.usbVendorId)}:${hex(info.usbProductId ?? 0)}`;
  return vendor ? `${vendor} (USB ${id})` : `USB ${id}`;
}

export class WebSerialTransport {
  kind = 'serial';

  constructor(port, serial) {
    this.port = port;
    this.serial = serial; // { baudRate, dataBits, parity, stopBits, flowControl }
    this.label = portLabel(port);
    this.onData = () => {};
    this.onClose = () => {};
    this.onWarn = () => {};
    this.reader = null;
    this.closing = false;
    this.loop = null;
  }

  async open() {
    const s = this.serial;
    await this.port.open({
      baudRate: Number(s.baudRate),
      dataBits: Number(s.dataBits),
      stopBits: Number(s.stopBits),
      parity: s.parity,
      flowControl: s.flowControl,
      bufferSize: 4096,
    });
    this.closing = false;
    this.loop = this.readLoop();
  }

  async readLoop() {
    const decoder = new TextDecoder('latin1');
    let error = null;
    while (this.port.readable && !this.closing) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length) this.onData(decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        // Framing/parity/buffer errors are recoverable: readable is recreated.
        if (['BreakError', 'FramingError', 'ParityError', 'BufferOverrunError'].includes(e?.name)) {
          this.onWarn(e.name);
          continue;
        }
        error = e;
        break;
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
    if (!this.closing) {
      this.closing = true;
      try {
        await this.port.close();
      } catch {
        /* already gone */
      }
      this.onClose(error ?? new Error('A porta foi fechada.'));
    }
  }

  async write(bytes) {
    if (!this.port.writable) throw new Error('Porta não está aberta para escrita.');
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    await this.loop?.catch(() => {});
    try {
      await this.port.close();
    } catch {
      /* ignore */
    }
  }
}
