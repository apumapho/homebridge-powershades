# PowerShades RF Gateway Protocol Analysis

## Summary
After reverse engineering the PowerShades RF gateway, we discovered that **percentage control is not available through the gateway web commands**. The gateway's HTTP interface only exposes basic commands (`up`, `down`, `stop`) through its local web interface.

Update 2026-05-27: PowerShades Config.NET uses a local UDP protocol on port 42 that can send percentage, movement, feedback, and channel-name commands. See `local-udp-protocol.js` and `tools/powershades-local-udp.js`.

## Gateway Architecture
- Gateway polls PowerShades cloud via HTTPS every ~13 seconds
- Cloud sends `SRV SetPos [channel]` commands to gateway
- Gateway translates to RF packets at 433.92MHz ± 100KHz
- Local web UI at `http://gateway-ip/` only supports basic commands

## Available Gateway Web Commands
```
http://gateway-ip/ajax.shtml?up=CHANNEL
http://gateway-ip/ajax.shtml?down=CHANNEL
http://gateway-ip/ajax.shtml?stop=CHANNEL
http://gateway-ip/ajax.shtml?pair=CHANNEL
http://gateway-ip/ajax.shtml?link=CHANNEL
http://gateway-ip/ajax.shtml?p2=CHANNEL
http://gateway-ip/ajax.shtml?reboot=0
```

## HTTP Percentage Control Discovery

### Debug Output Monitoring
Gateway has debug endpoint at `http://gateway-ip/debug.shtml` which shows real-time logs via:
```bash
curl "http://gateway-ip/ajax.shtml?var=dbg_out"
```

### Captured Percentage Commands

**Example 1: Channel 4 to 100%**
```
11:31:49.595 SRV SetPos [4]
11:31:52.599 SCH ExeNextAct 1-WAY: ACTMASK[00000008] BANK[1] CH[00000008] PCT 100
11:31:52.607 W433 TXP[56] 12 C1 0027003C:0027003C 0008 {02 04 40 00 00 00 00 00}
```

**Example 2: Channel 1 to 50%**
```
11:31:58.738 SRV SetPos [1]
11:32:01.742 SCH ExeNextAct 1-WAY: ACTMASK[00000001] BANK[1] CH[00000001] PCT 50
11:32:01.750 W433 TXP[59] 12 C1 0027003C:0027003C 0001 {02 04 40 32 00 00 00 00}
```

## RF Protocol Format

### Packet Structure
```
W433 TXP[N] 12 C1 0027003C:0027003C CHANNEL_MASK {02 04 40 PERCENT 00 00 00 00}
```

### Percentage Encoding
- **Byte 4** contains percentage in hex
- 0% (fully open) = `0x00`
- 50% = `0x32` (50 decimal)
- 75% = `0x4B` (75 decimal)
- 100% (fully closed) = `0x64` (100 decimal)

### Command Structure
- Bytes: `02 04 40 [PCT] 00 00 00 00`
- Gateway sends command 3 times (retry pattern)
- 1-WAY communication (no acknowledgment from motor)

## Gateway Information
- Firmware Version: 226
- Debug endpoint: `http://gateway-ip/debug.shtml`
- Variables endpoint: `http://gateway-ip/ajax.shtml?var=VARIABLE`
- Polls cloud with: `SRV GetStat [0-12]` every ~13 seconds
- Sends `Op_KeepAlive` to cloud periodically

## Tested but Failed Local Commands
None of these triggered percentage control:
```
?pos=50&channel=1
?position=50&channel=1
?percent=50&channel=1
?set=50&channel=1
?SetPos=75&channel=1
?pos=75&ch=1
?pct=75&channel=1
?setpos=50&channel=1
```

## Conclusion
**Local percentage control via HTTP is not possible** with current firmware. Local percentage control is possible through the Config.NET UDP protocol on port 42.

## Config.NET Local UDP Protocol

Config.NET sends UDP packets to the gateway on port 42. The common packet layout is:

```
uint16le payload_length
uint16le crc16_ccitt_bytes_4_to_end
uint8    command
uint8    sequence
uint16le channel
...      command payload
```

The checksum is CRC-16/CCITT with initial value `0`, calculated over bytes 4 through the end of the packet and stored little-endian at bytes 2-3.

Known command bytes:

```
0x03 up
0x04 down
0x05 stop
0x16 p2
0x1a set position
0x21 link feedback
0x3b rename channel
```

Examples:

```
Channel 15 to 50%, sequence 0x66:
0a 00 51 96 1a 66 0f 00 01 00 32 00 00 00 00 00 00 00

Channel 15 stop, sequence 0x71:
00 00 43 43 05 71 0f 00

Rename channel 15 to "Bedroom Window", sequence 0x33:
32 00 58 c9 3b 33 0f 00 4d 61 73 74 65 72 20 57 69 6e 64 6f 77 00 ...
```

## Options for Percentage Control
1. **Config.NET UDP protocol** - local port 42 commands implemented by this repo's UDP CLI/library and Homebridge local mode.
2. **Cloud API** - 300-400ms latency via PowerShades cloud.
3. **RF Hardware** - would need 433.92MHz transmitter to send raw RF packets.
4. **Firmware Modification** - risky, requires reverse engineering embedded firmware.

## Recommendations
Use `controlMode: "local-udp"` for Homebridge installations that can reach the
RF Gateway V2 on the local network. Keep cloud mode available for users who need
remote cloud discovery or who cannot route UDP port 42 from Homebridge to the
gateway.
