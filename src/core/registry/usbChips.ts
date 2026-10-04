/**
 * USB-to-serial bridge and native-USB device catalog. Used to describe what a
 * connected device is and which driver it needs. VIDs/PIDs are uppercase hex.
 */

export type UsbChipFamily = 'ch34x' | 'cp210x' | 'ftdi' | 'arduino-native' | 'espressif-native' | 'rp2040' | 'unknown';

export interface DriverInfo {
  family: UsbChipFamily;
  name: string;
  vendor: string;
  /** Official vendor download page. IoT-OS links here; it never downloads or runs installers itself. */
  downloadUrl: string | null;
  /** Per-OS guidance. `builtIn` means the OS normally ships a working driver. */
  os: Record<'darwin' | 'win32' | 'linux', { builtIn: boolean; guidance: string }>;
}

export interface UsbChipMatch {
  vid: string;
  pid: string;
  family: UsbChipFamily;
  chip: string;
}

export const USB_CHIPS: UsbChipMatch[] = [
  { vid: '1A86', pid: '7523', family: 'ch34x', chip: 'CH340' },
  { vid: '1A86', pid: '5523', family: 'ch34x', chip: 'CH341' },
  { vid: '1A86', pid: '55D4', family: 'ch34x', chip: 'CH9102' },
  { vid: '1A86', pid: '55D3', family: 'ch34x', chip: 'CH343' },
  { vid: '10C4', pid: 'EA60', family: 'cp210x', chip: 'CP2102/CP2104' },
  { vid: '10C4', pid: 'EA70', family: 'cp210x', chip: 'CP2105' },
  { vid: '10C4', pid: 'EA71', family: 'cp210x', chip: 'CP2108' },
  { vid: '0403', pid: '6001', family: 'ftdi', chip: 'FT232R' },
  { vid: '0403', pid: '6010', family: 'ftdi', chip: 'FT2232' },
  { vid: '0403', pid: '6014', family: 'ftdi', chip: 'FT232H' },
  { vid: '0403', pid: '6015', family: 'ftdi', chip: 'FT231X' },
  { vid: '303A', pid: '1001', family: 'espressif-native', chip: 'ESP32-S3/C3 USB Serial/JTAG' },
  { vid: '2E8A', pid: '0005', family: 'rp2040', chip: 'RP2040 (MicroPython)' },
  { vid: '2E8A', pid: '000A', family: 'rp2040', chip: 'RP2040 (Arduino)' },
  { vid: '2E8A', pid: '0003', family: 'rp2040', chip: 'RP2040 BOOTSEL' },
];

/** Vendor IDs that identify a whole family regardless of PID. */
const VENDOR_FAMILIES: Record<string, UsbChipFamily> = {
  '2341': 'arduino-native',
  '2A03': 'arduino-native',
  '303A': 'espressif-native',
  '2E8A': 'rp2040',
  '1A86': 'ch34x',
  '10C4': 'cp210x',
  '0403': 'ftdi',
};

export const DRIVERS: Record<UsbChipFamily, DriverInfo> = {
  ch34x: {
    family: 'ch34x',
    name: 'WCH CH34x USB-serial driver',
    vendor: 'WCH (Nanjing Qinheng Microelectronics)',
    downloadUrl: 'https://www.wch-ic.com/downloads/CH34XSER_MAC_ZIP.html',
    os: {
      darwin: {
        builtIn: true,
        guidance:
          'Recent macOS versions include a CH34x driver. If the device appears under USB but no /dev/cu.* port is created, install the WCH driver and approve the system extension in System Settings → Privacy & Security.',
      },
      win32: {
        builtIn: false,
        guidance: 'Windows Update usually installs CH340 drivers automatically. Otherwise install CH341SER.EXE from WCH.',
      },
      linux: { builtIn: true, guidance: 'Supported by the in-kernel ch341 module. Add your user to the dialout (or uucp) group for port access.' },
    },
  },
  cp210x: {
    family: 'cp210x',
    name: 'Silicon Labs CP210x VCP driver',
    vendor: 'Silicon Labs',
    downloadUrl: 'https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers',
    os: {
      darwin: {
        builtIn: true,
        guidance:
          'Recent macOS versions include a CP210x driver. If no /dev/cu.* port appears, install the Silicon Labs VCP driver and approve it in System Settings → Privacy & Security.',
      },
      win32: { builtIn: false, guidance: 'Install the Silicon Labs CP210x Universal Windows Driver.' },
      linux: { builtIn: true, guidance: 'Supported by the in-kernel cp210x module. Add your user to the dialout group.' },
    },
  },
  ftdi: {
    family: 'ftdi',
    name: 'FTDI VCP driver',
    vendor: 'FTDI',
    downloadUrl: 'https://ftdichip.com/drivers/vcp-drivers/',
    os: {
      darwin: { builtIn: true, guidance: 'macOS includes an FTDI driver (AppleUSBFTDI).' },
      win32: { builtIn: false, guidance: 'Windows Update usually provides FTDI drivers; otherwise install the VCP driver from FTDI.' },
      linux: { builtIn: true, guidance: 'Supported by the in-kernel ftdi_sio module. Add your user to the dialout group.' },
    },
  },
  'arduino-native': {
    family: 'arduino-native',
    name: 'USB CDC-ACM (class-compliant)',
    vendor: 'Arduino',
    downloadUrl: null,
    os: {
      darwin: { builtIn: true, guidance: 'Class-compliant; no driver needed on macOS.' },
      win32: { builtIn: true, guidance: 'Windows 10+ includes usbser.sys. Older systems need the Arduino IDE drivers.' },
      linux: { builtIn: true, guidance: 'Uses cdc_acm. Add your user to the dialout group.' },
    },
  },
  'espressif-native': {
    family: 'espressif-native',
    name: 'USB CDC-ACM (class-compliant)',
    vendor: 'Espressif',
    downloadUrl: null,
    os: {
      darwin: { builtIn: true, guidance: 'Class-compliant; no driver needed.' },
      win32: { builtIn: true, guidance: 'Windows 10+ includes the CDC driver.' },
      linux: { builtIn: true, guidance: 'Uses cdc_acm. Add your user to the dialout group.' },
    },
  },
  rp2040: {
    family: 'rp2040',
    name: 'USB CDC-ACM / Mass storage (class-compliant)',
    vendor: 'Raspberry Pi',
    downloadUrl: null,
    os: {
      darwin: { builtIn: true, guidance: 'Class-compliant; no driver needed. In BOOTSEL mode the board appears as the RPI-RP2 drive.' },
      win32: { builtIn: true, guidance: 'Class-compliant on Windows 10+.' },
      linux: { builtIn: true, guidance: 'Uses cdc_acm. Add your user to the dialout group.' },
    },
  },
  unknown: {
    family: 'unknown',
    name: 'Unknown',
    vendor: 'Unknown',
    downloadUrl: null,
    os: {
      darwin: { builtIn: false, guidance: 'Unrecognized USB device. Check the board vendor documentation for its USB-serial chip.' },
      win32: { builtIn: false, guidance: 'Unrecognized USB device. Check Device Manager for the chip name.' },
      linux: { builtIn: false, guidance: 'Unrecognized USB device. Check `lsusb` output for the chip name.' },
    },
  },
};

export function normalizeHex(id: string | number | undefined | null): string | null {
  if (id === undefined || id === null || id === '') return null;
  const s = typeof id === 'number' ? id.toString(16) : id.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,4}$/.test(s)) return null;
  return s.toUpperCase().padStart(4, '0');
}

export function identifyUsbChip(vid: string | null, pid: string | null): { family: UsbChipFamily; chip: string | null } {
  if (!vid) return { family: 'unknown', chip: null };
  const exact = USB_CHIPS.find((c) => c.vid === vid && c.pid === pid);
  if (exact) return { family: exact.family, chip: exact.chip };
  const fam = VENDOR_FAMILIES[vid];
  return { family: fam ?? 'unknown', chip: null };
}
