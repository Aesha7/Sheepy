// Sleep sheep firmware: commands over Bluetooth AND USB
//   L,<brightness 0-100>,<seconds 0-1800>  -> start a fade
//   S                                      -> report status
// USB replies with JSON (sheep.py still works). Bluetooth sends "pats,light,level,target".
#include <ArduinoBLE.h>

const int LED_PINS[] = {9, 10};            // add 11 when you have the third LED
const int TOUCH_PIN = 2;
const int LIGHT_PIN = A0;
const float MAX_PCT = 100;                 // hard brightness cap
const unsigned long DEBOUNCE_MS = 30;
const unsigned long MIN_GAP_MS = 400;

BLEService sheepService("A06E5F31-0600-46ED-8657-17C3712FB50F");
BLEStringCharacteristic cmdChar("C8C9C213-A1FB-4AF2-A0D6-BED87FCEAD6C", BLEWrite, 40);
BLEStringCharacteristic statusChar("5781D30D-37B4-4463-A8D8-8019495468C1", BLERead | BLENotify, 20);
bool bleOk = false;

float level = 0, startLevel = 0, targetLevel = 0;
unsigned long rampStart = 0, rampMs = 0;
unsigned long patCount = 0;
float lightAvg = 0;

// ---- light ----
void showLevel(float pct) {
  float b = pct / 100.0;
  int v = (int)(b * b * 255 + 0.5);        // gamma ~2 so the slow start looks smooth
  for (int p : LED_PINS) analogWrite(p, v);
}

void setTarget(float pct, float seconds) {
  startLevel = level;
  targetLevel = constrain(pct, 0, MAX_PCT);                        // clamp brightness
  rampMs = (unsigned long)(constrain(seconds, 0, 1800) * 1000);    // clamp time
  rampStart = millis();
}

void updateRamp() {
  float t = (rampMs == 0) ? 1.0 : (float)(millis() - rampStart) / rampMs;
  if (t > 1.0) t = 1.0;
  level = startLevel + (targetLevel - startLevel) * t;
  showLevel(level);
}

// ---- status ----
String shortStatus() {                     // e.g. "4,412,35,80" - stays under 20 characters
  return String(patCount) + "," + String((int)lightAvg) + "," +
         String((int)(level + 0.5)) + "," + String((int)(targetLevel + 0.5));
}

void pushBle() {
  if (bleOk) statusChar.writeValue(shortStatus());
}

void printStatus() {                       // USB: JSON, same as step 4
  Serial.print("{\"ok\":true,\"pats\":");  Serial.print(patCount);
  Serial.print(",\"light\":");             Serial.print((int)lightAvg);
  Serial.print(",\"level\":");             Serial.print(level, 1);
  Serial.print(",\"target\":");            Serial.print(targetLevel, 1);
  Serial.println("}");
}

// ---- sensors ----
void updateTouch() {
  static int stable = LOW, lastRead = LOW;
  static unsigned long changedAt = 0, lastPat = 0;
  int r = digitalRead(TOUCH_PIN);
  if (r != lastRead) { lastRead = r; changedAt = millis(); }
  if (millis() - changedAt > DEBOUNCE_MS && r != stable) {
    stable = r;
    if (stable == HIGH && millis() - lastPat > MIN_GAP_MS) {
      lastPat = millis();
      patCount++;
      pushBle();                           // tell the phone right away
    }
  }
}

void updateLight() {
  static unsigned long lastRead = 0;
  if (millis() - lastRead < 20) return;
  lastRead = millis();
  lightAvg = lightAvg * 0.9 + analogRead(LIGHT_PIN) * 0.1;
}

// ---- commands (same for USB and Bluetooth) ----
void handleCommand(String cmd, bool fromUsb) {
  cmd.trim();
  if (cmd.length() == 0) return;
  bool ok = true;
  if (cmd == "S") {
    // nothing to change, just report
  } else if (cmd.startsWith("L,")) {
    int comma = cmd.indexOf(',', 2);
    if (comma < 0) ok = false;
    else setTarget(cmd.substring(2, comma).toFloat(), cmd.substring(comma + 1).toFloat());
  } else {
    ok = false;
  }
  if (fromUsb) {
    if (ok) printStatus();
    else Serial.println("{\"ok\":false,\"err\":\"use L,brightness,seconds or S\"}");
  }
  if (ok) pushBle();
  else if (bleOk && !fromUsb) statusChar.writeValue("ERR");
}

void readSerial() {
  static String buf = "";
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { handleCommand(buf, true); buf = ""; }
    else if (buf.length() < 40) buf += c;
  }
}

void setup() {
  Serial.begin(115200);
  for (int p : LED_PINS) pinMode(p, OUTPUT);
  pinMode(TOUCH_PIN, INPUT);
  lightAvg = analogRead(LIGHT_PIN);
  setTarget(0, 0);                         // start dark

  bleOk = BLE.begin();
  if (bleOk) {
    BLE.setLocalName("SleepSheep");
    BLE.setAdvertisedService(sheepService);
    sheepService.addCharacteristic(cmdChar);
    sheepService.addCharacteristic(statusChar);
    BLE.addService(sheepService);
    statusChar.writeValue(shortStatus());
    BLE.advertise();
  }
  Serial.println(bleOk ? "Sheep ready: USB + Bluetooth" : "Sheep ready: USB only (Bluetooth failed)");
}

void loop() {
  updateRamp();
  updateTouch();
  updateLight();
  readSerial();
  if (bleOk) {
    BLE.poll();
    if (cmdChar.written()) handleCommand(cmdChar.value(), false);
    static unsigned long lastPush = 0;
    if (millis() - lastPush > 1000) { lastPush = millis(); pushBle(); }   // live updates for the app
  }
}