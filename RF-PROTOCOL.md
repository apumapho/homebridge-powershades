# PowerShades RF Gateway Protocol Analysis

## Summary
After reverse engineering the PowerShades RF gateway, we discovered that **percentage control is NOT available via local HTTP commands**. The gateway only exposes basic commands (`up`, `down`, `stop`) through its local web interface. Percentage commands come exclusively from the PowerShades cloud server.

## Gateway Architecture
- Gateway polls PowerShades cloud via HTTPS every ~13 seconds
- Cloud sends `SRV SetPos [channel]` commands to gateway
- Gateway translates to RF packets at 433.92MHz ± 100KHz
- Local web UI at `http://gateway-ip/` only supports basic commands

## Available Local HTTP Commands
```
http://gateway-ip/ajax.shtml?up=CHANNEL
http://gateway-ip/ajax.shtml?down=CHANNEL
http://gateway-ip/ajax.shtml?stop=CHANNEL
http://gateway-ip/ajax.shtml?pair=CHANNEL
http://gateway-ip/ajax.shtml?link=CHANNEL
http://gateway-ip/ajax.shtml?p2=CHANNEL
http://gateway-ip/ajax.shtml?reboot=0
```

## Percentage Control Discovery

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
**Local percentage control via HTTP is not possible** with current firmware. The gateway firmware only accepts percentage commands from the cloud server's `SRV SetPos` protocol.

## Options for Percentage Control
1. **Cloud API** (current solution) - 300-400ms latency via PowerShades cloud
2. **RF Hardware** - Would need 433.92MHz transmitter to send raw RF packets
3. **Firmware Modification** - Risky, requires reverse engineering embedded firmware

## Recommendations
Continue using the optimized cloud API approach with:
- HTTP keep-alive (20-30% faster API calls)
- Shade list caching (reduces API calls)
- Adaptive polling (1s active, 10s idle, 30s transition)

Total response time: ~300-400ms, which is acceptable for smart home automation.
