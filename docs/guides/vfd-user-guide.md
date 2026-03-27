# VFD System User Guide

**Platform:** Aquaculture SaaS
**Version:** 1.0
**Date:** 2026-03-27
**Audience:** Fish farm operators, technicians, facility managers -- anyone who uses the VFD system

---

## Table of Contents

1. [What is a VFD and Why Do You Need One?](#1-what-is-a-vfd-and-why-do-you-need-one)
2. [Getting Started](#2-getting-started)
3. [Registering a New VFD Device](#3-registering-a-new-vfd-device)
4. [Monitoring Your VFDs](#4-monitoring-your-vfds)
5. [Controlling Your VFDs](#5-controlling-your-vfds)
6. [Remote Programming (Changing VFD Settings)](#6-remote-programming-changing-vfd-settings)
7. [Making Changes (The Change Set Process)](#7-making-changes-the-change-set-process)
8. [Understanding Risk Levels](#8-understanding-risk-levels)
9. [Automation Rules](#9-automation-rules)
10. [Audit Log (Who Changed What and When)](#10-audit-log-who-changed-what-and-when)
11. [SCADA Integration](#11-scada-integration)
12. [Troubleshooting](#12-troubleshooting)
13. [Quick Reference Card](#13-quick-reference-card)

---

## 1. What is a VFD and Why Do You Need One?

### 1.1 What is a VFD?

A **VFD** stands for **Variable Frequency Drive**. Think of it like a **dimmer switch for a motor**. Just like a dimmer switch lets you control how bright a light bulb is, a VFD lets you control how fast a motor spins.

Without a VFD, a motor has only two settings: fully on or fully off. With a VFD, you can run the motor at any speed you want -- 10%, 50%, 75%, or anything in between.

A VFD works by changing the **frequency** (the speed of the electrical signal) going to the motor. Higher frequency means the motor spins faster. Lower frequency means it spins slower.

### 1.2 Why Do Fish Farms Use VFDs?

Fish farms have many motors running pumps, aerators, and other equipment. VFDs let you control these motors precisely, which saves energy and protects your fish. Here are some common uses:

- **Water pumps:** Control how fast water flows into, out of, and around your fish tanks. You might need fast flow during feeding but slower flow at night.
- **Aerators:** These add oxygen to the water so your fish can breathe. A VFD lets you increase aeration when oxygen levels drop and decrease it when levels are fine.
- **Filtration pumps:** Control how fast water passes through your filters. Running them slower when the water is already clean saves electricity.
- **Feeding systems:** Automatic feeders use conveyor belts driven by motors. A VFD controls how fast the feed is distributed.
- **Heating/cooling pumps:** Circulate water through heaters or coolers. A VFD adjusts the flow to maintain the right water temperature.

### 1.3 What This Software Lets You Do

This VFD management module in the Aquaculture platform gives you the ability to:

| What You Can Do | What It Means |
|-----------------|---------------|
| Register devices | Add your VFD devices to the system using a step-by-step setup wizard |
| Monitor in real time | See live data from your VFDs -- motor speed, electrical current, temperature, and more |
| Send commands | Start, stop, change speed, or emergency-stop a motor from your computer |
| Program remotely | Change VFD settings (like maximum speed or ramp-up time) without walking to the device |
| Set up automation | Create rules like "if water temperature rises above 28 degrees, speed up the pump" |
| Track all changes | Every change is recorded permanently -- who changed what, when, and why |

### 1.4 Supported VFD Brands

The system works with 8 major VFD manufacturers:

| Brand | Common Model Series |
|-------|-------------------|
| **Danfoss** | FC102, FC302, FC51, VLT 2800, VLT 5000, VLT 6000, VLT HVAC |
| **ABB** | ACS580, ACS880, ACS355, ACS310, ACS550, ACS800, ACS1000 |
| **Siemens** | G120, G120C, G120D, G120P, G130, S120, MICROMASTER 440 |
| **Schneider Electric** | Altivar 12, 312, 320, 340, 600, 900, Process |
| **Yaskawa** | A1000, V1000, J1000, GA500, GA700, U1000, Z1000 |
| **Delta Electronics** | VFD-E, VFD-EL, VFD-C, VFD-CP, VFD-M, VFD-MS300, VFD-C2000 |
| **Mitsubishi Electric** | FR-A800, FR-E800, FR-F800, FR-D700, FR-A700, FR-E700 |
| **Rockwell Automation** | PowerFlex 523, 525, 527, 700, 753, 755 |

> **Tip:** If you are not sure what brand or model your VFD is, look at the **nameplate** (the metal label) on the front or side of the VFD device. It will show the manufacturer name, model number, and other details.

---

## 2. Getting Started

### 2.1 How to Log In

1. **Open** your web browser (Google Chrome, Firefox, or Microsoft Edge are recommended).
2. **Type** the platform URL in the address bar at the top. Your system administrator will have given you this address. It typically looks like `https://your-company.aquaculture-platform.com`.
3. **Press** Enter on your keyboard.
4. You should now see a login page with fields for your email and password.
5. **Type** your email address in the "Email" field.
6. **Type** your password in the "Password" field.
7. **Click** the "Log In" button.
8. If your credentials are correct, you will be taken to the main dashboard.

> **Troubleshooting:** If you see an error message saying "Invalid credentials," double-check that you typed your email and password correctly. Passwords are case-sensitive, which means "Password123" and "password123" are different. If you have forgotten your password, **click** the "Forgot Password" link on the login page.

### 2.2 Finding the VFD Section

Once you are logged in:

1. **Look** at the left side of the screen. You will see a vertical menu bar (a list of sections).
2. **Click** on "Sensors" in the menu. A submenu will expand.
3. **Click** on "VFD Management" in the submenu.
4. You should now see the VFD Management page. This is your main hub for everything VFD-related.

You should see a page with:
- A list of your registered VFD devices (if any have been added already)
- A blue "Add New VFD" button in the top-right area
- Filter options at the top to search by brand, status, or location

### 2.3 Understanding Your User Role

The system has four user roles. Your role determines what you are allowed to do:

| Role | What You Can Do |
|------|----------------|
| **VIEWER** | View VFD data, change history, and audit logs. You cannot make any changes. |
| **OPERATOR** | Everything a Viewer can do, plus send runtime commands (start, stop, change speed). |
| **MODULE_MANAGER** | Everything an Operator can do, plus create change sets (propose parameter changes), perform emergency rollbacks, and enable/disable automation rules. |
| **TENANT_ADMIN** | Full access. Everything a Module Manager can do, plus approve or reject change sets, create automation rules, and configure automatic application settings. |

> **Tip:** If you try to do something and see a message like "Insufficient permissions," it means your role does not have access to that action. Contact your system administrator to request a role upgrade if needed.

---

## 3. Registering a New VFD Device

To add a new VFD device to the system, you will use a 6-step setup wizard. A wizard is simply a series of screens that guide you through a process one step at a time.

### Starting the Wizard

1. **Go** to the VFD Management page (Sensors > VFD Management).
2. **Click** the blue "Add New VFD" button in the top-right corner.
3. A new page will open showing "Step 1 of 6" at the top.

### Step 1: Choose the Brand

This step asks you to select the manufacturer of your VFD device.

1. You will see a list of brand logos and names, divided into two groups:
   - **Popular Brands** (most commonly used): Danfoss, ABB, Siemens, Schneider Electric
   - **Other Brands:** Yaskawa, Delta Electronics, Mitsubishi Electric, Rockwell Automation
2. **Click** on the brand that matches your VFD device.
3. The selected brand will be highlighted with a blue border.
4. **Click** "Next" to continue to Step 2.

> **Tip:** Before starting, check the nameplate (the metal label) on your physical VFD device. The brand and model information is printed there. If you are unsure, take a photo of the nameplate and ask your electrician or equipment supplier.

### Step 2: Choose the Communication Protocol

A **protocol** is simply the "language" that the platform uses to talk to your VFD. Different VFDs support different languages. You need to pick the one that matches how your VFD is physically connected.

The most common options are:

| Protocol | What It Means | When to Use It |
|----------|--------------|----------------|
| **Modbus RTU** | Communication over a serial cable (a special 2-wire cable called RS-485) | Most common choice. Use this if your VFD is connected with a twisted-pair cable. Available on ALL brands. |
| **Modbus TCP** | Communication over a network cable (standard Ethernet, like the cables used for internet) | Use this for newer installations where VFDs are connected to your network. Good for remote access. |
| **Profibus DP** | A high-speed industrial protocol | Mainly used in Siemens-based systems. Use if your existing system uses Profibus. |
| **Profinet** | Real-time communication over Ethernet | Common in modern Siemens and other European systems. |
| **EtherNet/IP** | Industrial Ethernet protocol | Standard in Rockwell/Allen-Bradley systems. |
| **CANopen** | Communication over CAN bus (a lightweight, low-cost cable) | Used with compact devices and lower-cost setups. |
| **BACnet/IP** or **BACnet MS/TP** | Building automation protocol | Used when integrating VFDs with building management systems (HVAC). |

1. You will see only the protocols that are supported by the brand you selected in Step 1.
2. **Click** on the protocol that matches your physical setup.
3. **Click** "Next" to continue.

> **Tip:** If you are not sure which protocol to choose, **Modbus RTU** is the safest default for most aquaculture facilities with existing serial wiring. For new installations using network cables, choose **Modbus TCP**.

> **Troubleshooting:** If you do not see the protocol you need, it may not be supported by the brand you selected. Go back to Step 1 and verify you chose the correct brand. Check the brand compatibility table in Chapter 1 for supported protocols per brand.

### Step 3: Enter Device Details

In this step, you provide basic information about the VFD.

1. **Select** the **Model Series** from the dropdown list. This will show only models from the brand you selected. For example, if you chose Danfoss, you might see FC302, FC102, FC51, etc.
2. **Type** a **Device Name** that will help you identify this VFD easily. Use a name that makes sense to your team.
   - Good examples: "Intake Pump VFD #1", "Aerator B-Block", "Filter Pump Tank-3"
   - Bad examples: "VFD1", "test", "asdf"
3. **Type** the **Location** where the device is physically installed. For example: "Building B, Panel 3" or "Tank Area, East Wall".
4. Optionally, **type** a **Description** with any additional notes. For example: "Controls the main circulation pump for tanks 1-4."
5. **Click** "Next" to continue.

### Step 4: Configure the Connection

This step is where you enter the technical details of how the platform will communicate with your VFD. The fields you see depend on which protocol you chose in Step 2.

#### If you chose Modbus RTU (serial cable):

| Field | What to Enter | Example |
|-------|--------------|---------|
| **Serial Port** | The name of the physical port on the computer or gateway | COM1 or /dev/ttyUSB0 |
| **Slave ID** | The unique address of this VFD on the serial cable (a number from 1 to 247). Each VFD on the same cable must have a different number. | 1 |
| **Baud Rate** | The communication speed. This MUST match the setting on the VFD itself. | 9600 (most brands) or 19200 (Schneider, Rockwell) |
| **Data Bits** | Usually 8. Do not change unless you know otherwise. | 8 |
| **Parity** | Error-checking method. Must match the VFD setting. | None (most brands), Even (Siemens, Schneider) |
| **Stop Bits** | Usually 1, except Yaskawa which uses 2. | 1 or 2 |
| **Timeout** | How long to wait for a response (in milliseconds). | 1000 |
| **Retry Count** | How many times to retry if communication fails. | 3 |

The system will pre-fill default values based on the brand you selected. Here are the defaults per brand:

| Brand | Baud Rate | Parity | Stop Bits |
|-------|-----------|--------|-----------|
| Danfoss | 9600 | None | 1 |
| ABB | 9600 | None | 1 |
| Siemens | 9600 | **Even** | 1 |
| Schneider | **19200** | **Even** | 1 |
| Yaskawa | 9600 | None | **2** |
| Delta | 9600 | None | 1 |
| Mitsubishi | 9600 | None | 1 |
| Rockwell | **19200** | None | 1 |

> **WARNING:** The communication settings you enter here MUST exactly match the settings on the physical VFD device. If they do not match, the platform will not be able to talk to the VFD. If you are unsure of the VFD's current settings, check the VFD's own display panel or ask the electrician who installed it.

#### If you chose Modbus TCP (network cable):

| Field | What to Enter | Example |
|-------|--------------|---------|
| **IP Address** | The network address of the VFD (required) | 192.168.1.100 |
| **Port** | The TCP port number (usually 502) | 502 |
| **Unit ID** | The Modbus unit address (usually 1) | 1 |
| **Connection Timeout** | How long to wait when establishing the connection (milliseconds) | 5000 |
| **Response Timeout** | How long to wait for a response (milliseconds) | 3000 |
| **Keep Alive** | Whether to keep the connection open (recommended: Yes) | Yes |

#### If you chose Profinet:

| Field | What to Enter | Example |
|-------|--------------|---------|
| **Device Name** | The PROFINET device name (required) | vfd-pump-01 |
| **IP Address** | The device's IP address (required) | 192.168.1.100 |
| **Subnet Mask** | The network subnet mask | 255.255.255.0 |
| **Update Rate** | How often data is exchanged (milliseconds) | 32 |

#### If you chose EtherNet/IP:

| Field | What to Enter | Example |
|-------|--------------|---------|
| **IP Address** | The device's IP address (required) | 192.168.1.100 |
| **Port** | The TCP port number | 44818 |
| **RPI** | Requested Packet Interval -- how often data is exchanged (milliseconds) | 10 |
| **Connection Type** | The type of connection | Exclusive Owner |

After entering all the required fields, **click** "Next" to continue.

### Step 5: Test the Connection

This step lets you verify that the platform can actually communicate with your VFD.

1. **Click** the "Test Connection" button.
2. **Wait** while the system performs the following checks:
   - Checks the physical connection
   - Performs a protocol handshake (an initial "hello" between the platform and the VFD)
   - Reads the VFD's status
   - Reads basic motor data (frequency, current, voltage) to confirm everything works
   - Measures communication speed and reliability

**What you will see if the test succeeds:**

A green checkmark will appear, along with:
- Device information (manufacturer, model, firmware version)
- Live motor readings (current frequency, speed, current draw, voltage)
- Device status (Ready, Running, Fault, etc.)
- Communication statistics (packets sent/received, average delay)

**What you will see if the test fails:**

A red X will appear, along with:
- An error message explaining what went wrong
- A checklist of things to check

> **Tip:** The connection test is optional. You can **click** "Skip Test" to proceed without testing. However, we strongly recommend testing to make sure everything is set up correctly before you start relying on the VFD.

> **Troubleshooting:** If the test fails, go back to Step 4 and double-check all your settings. The most common problems are: wrong IP address, wrong baud rate, wrong parity setting, or a loose cable. See Chapter 12 (Troubleshooting) for detailed solutions.

**Click** "Next" to continue.

### Step 6: Review and Save

The final step shows a summary of everything you have entered:

- Selected brand and model
- Protocol and connection settings
- Connection test result (if you ran the test)
- Device name, location, and description

1. **Review** all the information carefully.
2. If anything is wrong, **click** "Back" to go to the relevant step and fix it.
3. If everything looks correct, **click** the "Save VFD" button.

Your VFD device is now registered in the system. It starts in **DRAFT** status (meaning it has been saved but not yet fully activated).

### Understanding Device Statuses

After you register a VFD, it goes through several status stages:

| Status | What It Means | What You Can Do |
|--------|--------------|----------------|
| **DRAFT** | Device saved but not tested yet | Edit settings, delete, send to testing |
| **PENDING_TEST** | Waiting in the test queue | Cancel the test |
| **TESTING** | Connection test is running right now | Wait for it to finish |
| **ACTIVE** | Device is working and ready to use | Monitor, send commands, program settings |
| **TEST_FAILED** | Connection test did not pass | Retry the test, edit settings, or delete |
| **SUSPENDED** | Device temporarily paused | Reactivate or delete |
| **OFFLINE** | Device is not responding (communication lost) | Try reconnecting |

> **WARNING:** Only devices in **ACTIVE** status can receive commands or have their settings changed. If your device is in any other status, you need to get it to ACTIVE first.

### Managing Your VFD Device List

The VFD Management page shows all your registered devices in a table. You can:

- **Filter** by brand, status, protocol, or location using the dropdown menus at the top
- **Click** on a device name to see its details
- **Click** the trash can icon to delete a device (only available for DRAFT or TEST_FAILED devices)
- **Click** the pause icon to suspend an active device

---

## 4. Monitoring Your VFDs

Once a VFD device is in ACTIVE status, the platform continuously reads data from it and displays it on the device detail page.

### 4.1 Reading the Dashboard

To view a VFD's live data:

1. **Go** to VFD Management (Sensors > VFD Management).
2. **Click** on the name of the device you want to monitor.
3. You will see the device detail page with live data updating automatically.

### 4.2 Understanding Each Number

The monitoring screen shows several categories of information. Here is what each number means in plain language:

#### Motor Information

| What You See | What It Means | Unit | Example |
|-------------|--------------|------|---------|
| **Output Frequency** | How fast the motor is currently spinning, expressed as an electrical frequency. Higher number = faster motor. | Hz (Hertz) | 42.5 Hz |
| **Motor Current** | How much electrical current the motor is drawing right now. Higher current usually means the motor is working harder. | A (Amperes) | 12.34 A |
| **Motor Voltage** | The voltage being supplied to the motor. | V (Volts) | 380.2 V |
| **Motor Speed** | How fast the motor shaft is actually turning, in revolutions per minute. | RPM | 1425 RPM |
| **Motor Torque** | How hard the motor is "pushing," shown as a percentage of its maximum ability. | % | 78.5% |
| **Output Power** | How much power the motor is producing. | kW (kilowatts) | 5.5 kW |
| **DC Bus Voltage** | The internal voltage inside the VFD. This is a technical value -- you mainly need it for troubleshooting. | V (Volts) | 540.0 V |
| **Power Factor** | A measure of how efficiently the motor is using electricity. Closer to 1.0 is better. | (no unit) | 0.85 |
| **Speed Reference** | The target speed that the VFD is trying to reach. The actual frequency may be ramping toward this value. | Hz | 45.0 Hz |

#### Temperature Information

| What You See | What It Means | Unit | Example |
|-------------|--------------|------|---------|
| **Heatsink Temperature** | The temperature of the VFD's cooling surface. The VFD generates heat and uses a metal heatsink to dissipate it. | degrees C | 45.2 |
| **Control Board Temperature** | The temperature of the VFD's electronic circuit board. | degrees C | 38.7 |
| **Motor Thermal Load** | An estimate of how hot the motor is, shown as a percentage. 100% means the motor has reached its thermal limit. | % | 62% |

#### Energy and Usage Information

| What You See | What It Means | Unit | Example |
|-------------|--------------|------|---------|
| **Running Hours** | Total time the motor has been running since the VFD was installed. | hours | 12,450 |
| **Power On Hours** | Total time the VFD has been powered on (even when the motor is stopped). | hours | 15,200 |
| **Energy Consumption** | Total electricity used by this motor. | kWh | 85,600 |
| **Start Count** | How many times the motor has been started. | count | 3,241 |

#### Fault Information

| What You See | What It Means |
|-------------|--------------|
| **Alarm Word** | A technical code showing active alarms. The system translates this into human-readable alerts. |
| **Warning Word** | A technical code showing active warnings. |
| **Fault Code** | If the VFD has stopped due to an error, this shows the error code. See Chapter 12 for what each code means. |

### 4.3 Status Indicators (Color Codes)

The device detail page uses colored labels (badges) to show the VFD's current state at a glance:

- **Green labels** (good): "Ready," "Running," "At Reference" -- everything is working normally
- **Yellow labels** (attention needed): "Warning," "Thermal Warning," "Current Limit" -- the VFD is still running but something needs attention
- **Red labels** (problem): "Fault," "Trip Lock" -- the VFD has stopped due to an error and needs attention immediately

### 4.4 How Often Data Updates

The system reads different parameters at different speeds, depending on how important they are:

| Priority | What Gets Read | How Often | Why |
|----------|---------------|-----------|-----|
| **Critical** | Status, alarms, warnings | Every 0.2 seconds | Faults need to be detected immediately |
| **Motor** | Frequency, current, speed, torque, power | Every 0.5 seconds | Motor performance needs near-real-time monitoring |
| **Voltage** | Motor voltage, DC bus voltage, power factor | Every 1 second | Voltage changes slowly |
| **Thermal** | Heatsink temp, board temp, motor thermal load | Every 5 seconds | Temperature changes very slowly |
| **Energy** | Running hours, energy consumption, start count | Every 60 seconds | Counter values rarely change |

> **Tip:** The polling intervals (how often data is read) can be customized from the device detail page. However, setting very short intervals for all parameters (for example, 100ms for everything) can overload the communication line and cause timeout errors.

---

## 5. Controlling Your VFDs

This chapter covers how to send commands to your VFD devices -- starting motors, stopping them, and changing their speed.

> **Note:** You need at least the **OPERATOR** role to send commands. If you are a VIEWER, you can only watch.

### 5.1 Starting a Motor

1. **Go** to the device detail page by clicking on the VFD in the device list.
2. **Find** the "Command Panel" section on the page.
3. **Click** the green "Start" button.
4. A confirmation dialog will appear asking: "Are you sure you want to start this motor?"
5. **Click** "Confirm" to send the start command.
6. You should see a success message, and the motor status should change to "Running" within a few seconds.

The motor will ramp up (gradually increase speed) to its target frequency according to the acceleration time configured in the VFD.

### 5.2 Stopping a Motor

1. **Find** the "Command Panel" section on the device detail page.
2. **Click** the red "Stop" button.
3. The motor will ramp down (gradually decrease speed) and stop smoothly.
4. No confirmation is needed for a normal stop.

The motor will slow down according to the deceleration time configured in the VFD. This is called a "ramp stop" and is the safest way to stop a motor.

### 5.3 Changing the Speed (Frequency)

There are two ways to change motor speed:

#### Option A: Set Frequency (in Hz)

This sets the motor's running frequency directly in Hertz.

1. **Find** the "Command Panel" section.
2. **Click** "Set Frequency."
3. **Type** the desired frequency value. For example, type `35.0` to run the motor at 35.0 Hz.
4. A confirmation dialog will appear.
5. **Click** "Confirm" to apply.

The motor speed will change to match the new frequency, ramping up or down smoothly.

> **Note:** The actual frequency is limited by the VFD's configured minimum and maximum frequency settings. For example, if the maximum frequency is set to 50 Hz and you try to set 55 Hz, the VFD will limit it to 50 Hz.

#### Option B: Set Speed (as percentage)

This sets the motor speed as a percentage of its maximum.

1. **Click** "Set Speed."
2. **Type** a value from 0 to 100. For example, `70` means 70% of maximum speed.
3. **Click** "Confirm."

### 5.4 Emergency Stop

> **WARNING:** Emergency Stop immediately cuts power to the motor without any gradual slowdown. This is for dangerous situations ONLY. Using Emergency Stop can cause mechanical damage to pumps, pipes, and couplings. In water systems, it can cause "water hammer" (a sudden pressure surge that can damage pipes).

**Any logged-in user can use Emergency Stop, regardless of their role.** This is by design -- safety comes first.

1. **Click** the large red "EMERGENCY STOP" button (usually prominent on the page).
2. The motor stops immediately. No confirmation is needed.

Use Emergency Stop only when:
- Someone is in immediate danger
- Equipment is visibly sparking or smoking
- Water is flooding uncontrollably
- Any other situation where waiting even a few seconds could cause harm

### 5.5 Other Commands

| Command | What It Does | Needs Confirmation? |
|---------|-------------|-------------------|
| **Reverse** | Changes the direction the motor spins | Yes |
| **Fault Reset** | Clears an error so the VFD can run again after a fault | No |
| **Quick Stop** | Stops the motor faster than normal (shorter ramp-down) but not as abrupt as Emergency Stop | No |
| **Coast Stop** | Cuts power and lets the motor spin freely until it stops on its own (like turning off a fan and letting it wind down) | No |
| **Jog Forward** | Runs the motor slowly in the forward direction, only while you hold the button. Used for testing. | No |
| **Jog Reverse** | Same as Jog Forward but in the opposite direction | No |

> **Tip:** Jog mode is perfect for checking if a pump is spinning in the correct direction after installation. Run it briefly in Jog Forward, then Jog Reverse, and verify which direction moves water the right way.

### 5.6 Batch Commands (Controlling Multiple VFDs at Once)

You can send the same command to multiple VFDs simultaneously. This is useful for:
- Starting all tank pumps at the same time
- Setting all aerators to a specific speed
- Emergency-stopping all devices at once

There are two batch modes:

| Mode | What It Does | When to Use It |
|------|-------------|----------------|
| **Sequential** | Sends commands one by one, waiting for each to succeed before sending the next | When a failure on one device should stop the rest (for example, devices that depend on each other) |
| **Parallel** | Sends commands to all devices at the same time | When devices are independent and you want speed |

### 5.7 Command History

Every command you send is recorded. To view the history:

1. **Go** to the device detail page.
2. **Scroll** down to the "Command History" section.
3. You will see the last 50 commands with timestamps, who sent them, and whether they succeeded or failed.

---

## 6. Remote Programming (Changing VFD Settings)

### 6.1 What is a "Parameter"?

A **parameter** is a setting stored inside the VFD that controls how it behaves. Think of it like the settings on your phone -- screen brightness, volume, language, etc. VFDs have similar settings that control things like:

- How fast the motor can go (maximum speed)
- How quickly the motor speeds up (acceleration time)
- How quickly the motor slows down (deceleration time)
- What the motor's electrical ratings are
- How the VFD protects the motor from damage

Parameters are different from commands (like Start/Stop). Commands are temporary actions. Parameters are permanent settings that stay in the VFD's memory even after it is powered off.

### 6.2 Browsing Parameters

1. **Go** to the device detail page.
2. **Click** on the "Programming" tab.
3. On the left side, you will see a list of **parameter groups** (categories). Each group contains related settings.

### 6.3 Understanding Parameter Groups

Parameters are organized into 10 groups:

| Group | What It Controls | Example Parameters |
|-------|-----------------|-------------------|
| **Ramp Times** | How fast the motor speeds up and slows down | Acceleration Time, Deceleration Time |
| **Frequency Limits** | The minimum and maximum speed the motor can run at | Minimum Frequency, Maximum Frequency |
| **Motor Nameplate** | The electrical ratings of the motor (from the motor's label) | Nominal Power, Voltage, Current, Speed |
| **Current/Torque Limits** | Maximum electrical current the motor can draw | Current Limit % |
| **V/f Control** | The relationship between voltage and frequency (technical motor control setting) | V/f Curve Mode, Voltage Boost |
| **PID Controller** | Automatic speed control based on a sensor reading (like maintaining a target temperature) | P Gain, I Time, D Time |
| **Digital I/O** | What physical input and output connections on the VFD do | Digital Input Functions, Digital Output Functions |
| **Communication** | Network and serial communication settings | Modbus Address, Baud Rate |
| **Protection** | Safety settings that protect the motor from damage | Thermal Protection Mode |
| **Jog** | Settings for jog mode (low-speed testing mode) | Jog Frequency |

### 6.4 Reading Current Values

When you click on a parameter group:

1. A table appears showing all parameters in that group.
2. For each parameter, you will see:
   - **Name:** The parameter name (for example, "Acceleration Time 1")
   - **Description:** A brief explanation of what it does
   - **Current Value:** The value currently stored in the VFD (read live from the device)
   - **Unit:** The measurement unit (seconds, Hz, Amps, %, Volts, RPM, etc.)
   - **Risk Level:** A colored indicator showing how risky it is to change this parameter (see Chapter 8)

### 6.5 What "Read-Only" Means

Some parameters are **read-only**, meaning you can see their value but cannot change it. These are typically real-time measurements (like current motor speed) rather than configurable settings. Read-only parameters will not have an editable field.

---

## 7. Making Changes (The Change Set Process)

### 7.1 Why We Use Change Sets

Changing VFD parameters can affect motor behavior, and incorrect changes can damage equipment. To keep things safe, this system uses a process called **Maker-Checker** (also known as the "four-eyes principle"). Here is how it works:

- **One person proposes the change** (the "Maker")
- **A different person reviews and approves it** (the "Checker")
- The same person cannot both propose AND approve a change

This is a safety requirement from the IEC 62443 industrial security standard. It prevents accidental or unauthorized changes from reaching your equipment.

A **change set** is a package of one or more parameter changes that are managed together as a group.

### 7.2 Step-by-Step: Creating and Applying a Change Set

#### Step 1: Pick the Parameters You Want to Change

1. **Go** to the device detail page and **click** the "Programming" tab.
2. **Click** on the parameter group that contains the setting you want to change (for example, "Ramp Times").
3. You will see a table with all parameters in that group, showing current values.

#### Step 2: Enter New Values

1. **Find** the parameter you want to change.
2. In the "New Value" column, **type** the value you want to set.
3. The system will automatically:
   - Check that your value is within the allowed range (minimum and maximum)
   - Evaluate the risk level of your change
   - Show a warning if the change requires the motor to be stopped first
4. You can change multiple parameters at once -- they will all be included in the same change set.

#### Step 3: Write a Description

1. In the "Description" field at the bottom, **type** an explanation of why you are making this change.
2. This description is **required**. It will be read by the person who approves your change and is permanently recorded in the audit log.

Good example: "Reducing pump ramp-up time from 10 seconds to 5 seconds to improve tank filling speed for the new tank layout."

Bad example: "changing stuff"

#### Step 4: Save or Submit

You have three options:

- **Save Draft:** Saves your changes as a draft. You can come back and edit them later. The changes are NOT sent for approval yet.
- **Submit for Approval:** Sends your change set to a supervisor (Checker) for review. You cannot edit it after submission.
- **Reset:** Discards all your changes and starts over.

#### Step 5: Wait for Approval

After you submit your change set:

1. All users with the TENANT_ADMIN role (Checkers) receive a notification.
2. A Checker will review your proposed changes.
3. The Checker can either **approve** or **reject** your change set.
4. You will receive a notification either way.

If your change set is **rejected**:
- The Checker must provide a reason for the rejection.
- You can edit your change set and resubmit it, or delete it entirely.

#### Step 6: Changes Are Applied

Once approved:

1. The system writes the new parameter values to the VFD device.
2. After writing, the system reads the values back to verify they were written correctly.
3. If everything matches, the change set status moves to "Verified."
4. If there is a mismatch, the status moves to "Failed" and the system may automatically rollback (undo) the changes.

### 7.3 Scheduling Changes for Later

You do not have to apply changes immediately. You can schedule them for a specific time:

1. Before submitting for approval, **find** the "Schedule" field.
2. **Select** a date and time when you want the changes to be applied.
3. This is useful for making changes during off-hours when the fish are less affected.

Examples:
- Schedule for 2:00 AM when production is minimal
- Schedule for a weekend maintenance window

### 7.4 Change Set Statuses

Your change set moves through these stages:

```
DRAFT --> PENDING_APPROVAL --> APPROVED --> APPLYING --> APPLIED --> VERIFIED
                           --> REJECTED                           --> ROLLED_BACK
                                                      --> FAILED --> ROLLED_BACK
```

| Status | What It Means | Who Does This |
|--------|--------------|---------------|
| **DRAFT** | You are still editing the changes | You (the Maker) |
| **PENDING_APPROVAL** | Waiting for a supervisor to review | You submitted it |
| **APPROVED** | A supervisor said "yes" -- ready to be applied | The Checker approved |
| **APPLYING** | The system is writing values to the VFD right now | Automatic |
| **APPLIED** | All values have been written to the VFD | Automatic |
| **VERIFIED** | The system read back the values and confirmed they are correct | Automatic |
| **REJECTED** | A supervisor said "no" and gave a reason | The Checker rejected |
| **FAILED** | Something went wrong during writing or verification | Automatic |
| **ROLLED_BACK** | The changes were undone and the previous values restored | Automatic or manual |

### 7.5 Notifications

The system sends notifications at every stage:

| Event | Who Gets Notified | How |
|-------|------------------|-----|
| Change set submitted for approval | All Checkers (TENANT_ADMIN users) | Platform notification + email |
| Change set approved | The Maker (you) | Platform notification |
| Change set rejected | The Maker (you) | Platform notification + email |
| Change set applied successfully | Maker + Checker | Platform notification |
| Change set failed | Maker + Checker + System Admin | Platform notification + email + alarm |
| Change set rolled back | Maker + Checker | Platform notification |

### 7.6 Rollback (Undoing Changes)

If a change causes problems, you can undo it:

#### Standard Rollback

1. **Go** to the change set history.
2. **Find** the change set you want to undo (it must be in APPLIED or VERIFIED status).
3. **Click** the "Rollback" button.
4. **Type** a reason for the rollback.
5. The system creates a new change set with the original values.
6. This new rollback change set goes through the normal approval process.

#### Emergency Rollback

In urgent situations, the approval process can be bypassed:

1. **Click** "Emergency Rollback."
2. **Type** a mandatory reason.
3. The changes are undone immediately, without waiting for approval.
4. This action is logged as an "emergency override" in the audit log and will be reviewed.

> **WARNING:** Emergency Rollback should only be used in genuine emergencies. All emergency rollbacks are logged in detail and audited. Use the standard rollback process under normal circumstances.

**Summary: The Change Set Process**

> The change set process ensures safety through dual approval. One person proposes changes (Maker), a different person approves them (Checker). All changes are recorded permanently. If something goes wrong, changes can be undone (rolled back). This protects your equipment and your fish.

---

## 8. Understanding Risk Levels

Every parameter change is assigned a risk level. This tells you how dangerous the change could be if the value is wrong.

### 8.1 Risk Level Colors

| Color | Level | What It Means | Example |
|-------|-------|--------------|---------|
| **GREEN** | LOW | Safe to change. Unlikely to cause any problems even if the value is slightly off. | Jog frequency, Modbus address, communication settings |
| **YELLOW** | MEDIUM | Moderate risk. Could affect motor behavior. Be careful but these changes are usually safe during normal operation. | Ramp times (acceleration/deceleration), PID controller settings, frequency limits |
| **ORANGE** | HIGH | Significant risk. Incorrect values could affect motor performance or require the motor to be stopped. | Motor nameplate values (power, voltage, current, speed), V/f curve settings, maximum frequency |
| **RED** | CRITICAL | Dangerous. Incorrect values could damage equipment, cause safety hazards, or require emergency intervention. | Disabling thermal protection, extremely short ramp times, frequencies far above motor rating |

### 8.2 Dynamic Risk Escalation

Some parameters start at one risk level but can escalate (increase) to a higher level based on the specific value you enter. The system warns you automatically when this happens.

Here are the escalation rules:

| What You Change | Normal Risk | When It Gets Worse | New Risk | Why It Is Dangerous |
|----------------|-------------|-------------------|----------|-------------------|
| Acceleration Time | YELLOW (MEDIUM) | Value less than 1.0 second | RED (CRITICAL) | Speeding up a motor in less than 1 second can cause mechanical shock, damage couplings, and trigger overcurrent faults |
| Deceleration Time | YELLOW (MEDIUM) | Value less than 0.5 seconds | RED (CRITICAL) | Stopping a motor in less than 0.5 seconds can cause excessive voltage in the DC bus and regenerative faults |
| Maximum Frequency | ORANGE (HIGH) | Value above 60 Hz | RED (CRITICAL) | Running a motor above its rated frequency can damage bearings, windings, and connected equipment |
| Thermal Protection | ORANGE (HIGH) | Set to "Off" (disabled) | RED (CRITICAL) | Disabling thermal protection removes the safety system that prevents the motor from overheating and potentially catching fire |
| Current Limit | YELLOW (MEDIUM) | Value above 200% | ORANGE (HIGH) | Allowing the motor to draw more than twice its rated current can exceed the motor's thermal capacity and cause damage |

### 8.3 Motor Stop Requirements

Some parameters can only be changed when the motor is NOT running. The system will tell you when this is the case. These parameters typically include:

- Motor Nominal Power
- Motor Nominal Voltage
- Motor Nominal Current
- Motor Nominal Speed
- V/f Curve Mode
- Voltage Boost
- Slip Compensation

If you try to apply a change set that includes these parameters while the motor is running, the system will reject the entire change set. You must stop the motor first.

> **Tip (for fish farm context):** When you need to change motor nameplate values (for example, because you replaced a pump motor), plan ahead. Schedule the change during a maintenance window when you can safely stop the motor without affecting your fish.

**Summary: Risk Levels**

> GREEN = safe, YELLOW = be careful, ORANGE = significant impact, RED = dangerous. Always read the warning messages. The system will not let you submit changes that are obviously out of range, but it trusts you to make good decisions within the allowed ranges.

---

## 9. Automation Rules

### 9.1 What Are Automation Rules?

Automation rules let you set up automatic VFD adjustments based on conditions from your sensors. Instead of manually changing a pump speed when water temperature rises, you can create a rule that does it for you.

Think of it like a thermostat in your home: "When the temperature drops below 20 degrees, turn on the heater." Automation rules work the same way but for your VFDs.

### 9.2 How Rules Work

Each automation rule has these parts:

| Part | What It Does | Required? |
|------|-------------|-----------|
| **Rule Name** | A descriptive name for the rule | Yes |
| **Description** | An explanation of what the rule does and why | Yes |
| **Trigger Condition** | The sensor conditions that activate the rule (for example: "water temperature > 28 degrees") | Yes |
| **Target VFD Devices** | Which VFD(s) should be changed when the rule triggers | Yes |
| **Parameter Changes** | What parameters to change and to what values | Yes |
| **Requires Approval** | Whether changes need supervisor approval or are applied automatically | Yes |
| **Priority** | Which rule wins if multiple rules trigger at the same time (lower number = higher priority) | Yes |
| **Cooldown Period** | How long to wait before the rule can trigger again (prevents rapid-fire changes) | Yes |

### 9.3 Real-World Examples

#### Example 1: Low Dissolved Oxygen -- Speed Up Aerators

**Situation:** If the dissolved oxygen (DO) in a fish tank drops below 5.0 mg/L, the fish are at risk. The aerator motor needs to speed up immediately to add more oxygen.

| Setting | Value |
|---------|-------|
| Rule Name | Low DO -- speed up aerators |
| Condition | dissolved_oxygen < 5.0 (mg/L) |
| Target VFDs | Aerator VFD #1, Aerator VFD #2 |
| Parameter Changes | acceleration_time = 3.0 seconds (fast ramp), max_frequency = 55.0 Hz |
| Requires Approval | No (automatic -- this is an emergency situation) |
| Cooldown | 900 seconds (15 minutes) |
| Priority | 1 (highest priority) |

> **WARNING:** Setting "Requires Approval" to "No" means changes are applied to the VFD immediately without any human review. Only TENANT_ADMIN users can configure this. Use automatic application only for well-tested emergency scenarios.

#### Example 2: Water Temperature Drop -- Increase Pump Ramp Time

**Situation:** When water temperature drops below 15 degrees C, motors should ramp up more slowly to reduce thermal shock in the piping.

| Setting | Value |
|---------|-------|
| Rule Name | Cold water -- slow pump ramp |
| Condition | water_temperature < 15.0 (degrees C) |
| Target VFDs | Intake Pump #1, Intake Pump #2 |
| Parameter Changes | acceleration_time = 15.0 seconds (slower ramp-up) |
| Requires Approval | Yes |
| Cooldown | 3600 seconds (1 hour) |
| Priority | 5 |

#### Example 3: High Pressure -- Reduce Maximum Frequency

**Situation:** If pipe pressure rises above 3.0 bar, the pump's maximum frequency should be reduced to protect the piping.

| Setting | Value |
|---------|-------|
| Rule Name | High pressure -- limit pump speed |
| Condition | pipe_pressure > 3.0 (bar) |
| Target VFDs | Main Circulation Pump |
| Parameter Changes | max_frequency = 40.0 Hz (reduced from 50 Hz) |
| Requires Approval | Yes |
| Cooldown | 1800 seconds (30 minutes) |
| Priority | 3 |

### 9.4 Creating a Rule (Step by Step)

> **Note:** Only TENANT_ADMIN users can create automation rules. MODULE_MANAGER users can enable or disable existing rules.

1. **Go** to VFD Management > Automation Rules.
2. **Click** "Create New Rule."
3. **Type** a clear, descriptive name for the rule.
4. **Type** a description explaining what the rule does and why.
5. **Set up the trigger condition:**
   - **Select** the sensor tag (for example, "water_temperature," "dissolved_oxygen," "pipe_pressure")
   - **Select** the comparison operator: greater than (>), less than (<), greater than or equal (>=), less than or equal (<=), equals (==), not equals (!=)
   - **Type** the threshold value
   - If you need multiple conditions, **click** "Add Condition" and choose AND (all conditions must be true) or OR (any condition must be true)
6. **Select** the target VFD device(s) from the dropdown list.
7. **Define** the parameter changes: which parameter to change and to what value.
8. **Choose** whether approval is required (recommended: Yes, unless it is a tested emergency scenario).
9. **Set** the priority (lower number = higher priority).
10. **Set** the cooldown period in seconds.
11. **Click** "Save Rule."

The rule starts in an active state by default and will begin monitoring sensor data immediately.

### 9.5 Enabling and Disabling Rules

1. **Go** to the Automation Rules page.
2. **Find** the rule you want to enable or disable.
3. **Click** the toggle switch next to the rule name.
4. A disabled rule will not react to sensor data.

### 9.6 Rule History

For each rule, the system tracks:
- When it was last triggered
- How many times it has triggered in total
- Which change sets it created
- How many succeeded and how many failed

### 9.7 What Happens When Multiple Rules Trigger at the Same Time?

If two rules both try to change the same VFD at the same time:
- The rule with the **lower priority number** wins (priority 1 beats priority 5).
- The losing rule is skipped, and this is logged.
- A notification is sent to administrators about the conflict.

### 9.8 Automatic Rule Deactivation

If a rule fails 3 times in a row:
- The rule is automatically deactivated.
- An alarm is sent to administrators.
- The rule must be manually reactivated after investigating the cause.

**Summary: Automation Rules**

> Automation rules let the system react to sensor data automatically. They are powerful but must be configured carefully. Always use the "Requires Approval" option unless you have thoroughly tested the rule and the situation demands immediate response.

---

## 10. Audit Log (Who Changed What and When)

### 10.1 What is the Audit Log?

The audit log is a permanent, unchangeable record of every parameter change made to every VFD in the system. Think of it as a security camera for your VFD settings -- it records everything and cannot be edited or deleted.

### 10.2 Finding the Audit Log

1. **Go** to VFD Management.
2. **Click** on a specific VFD device.
3. **Click** the "Audit Log" tab.

Or, for a system-wide view:
1. **Go** to VFD Management > Audit Log (if available as a top-level menu item).

### 10.3 Reading Log Entries

Each entry in the audit log shows:

| Field | What It Means | Example |
|-------|--------------|---------|
| **Timestamp** | When the change was applied | 2026-03-26 14:32:15 |
| **Change Set ID** | A reference number linking to the change set | CS-043 |
| **Parameter** | Which setting was changed | acceleration_time_1 |
| **Previous Value** | The value before the change | 10.00 |
| **New Value** | The value after the change | 5.00 |
| **Action** | What type of action this was | apply, rollback, auto_apply, emergency_override |
| **Performed By** | Who made the change | okan@aqua.com |
| **IP Address** | The network address of the person's computer | 192.168.1.50 |
| **Automation Rule** | If triggered by an automation rule, which one | rule-001 (or blank if manual) |

### 10.4 Filtering the Log

You can filter the audit log by:
- **Date range:** Show only entries from a specific time period
- **Parameter name:** Search for changes to a specific parameter
- **User:** Show only changes made by a specific person
- **Change Set ID:** Find all changes from a specific change set
- **Action type:** Filter by apply, rollback, or emergency_override

### 10.5 Why the Audit Log Matters

The audit log serves several important purposes:

- **Compliance:** Many regulations require a complete record of all changes to industrial equipment
- **Troubleshooting:** If something goes wrong, you can look back and see exactly what was changed, by whom, and when
- **Accountability:** Every change is tied to a specific person
- **Investigation:** If equipment is damaged, the audit log helps determine the cause

### 10.6 Retention Policy

- Audit log entries are **never deleted**
- Records are stored in monthly partitions for performance
- Every record is immutable (cannot be changed after creation)
- IP address and browser information are recorded with every entry

**Summary: Audit Log**

> Every change to every VFD parameter is permanently recorded. You can search and filter the log to find specific changes. This protects your organization and helps with troubleshooting.

---

## 11. SCADA Integration

### 11.1 What is SCADA?

**SCADA** (Supervisory Control and Data Acquisition) is a system that displays all your facility's equipment on a visual dashboard. The VFD module integrates with the platform's SCADA screens so you can see VFD information alongside other equipment data.

### 11.2 The VFD Widget on SCADA Screens

When a VFD is added to a SCADA screen, it appears as a widget (a small visual panel). There are two types:

#### Mini Widget
A compact view showing:
- Device name
- Current status (Running/Stopped/Fault) with color indicator
- Current frequency (Hz)
- Motor current (A)

This is suitable for overview screens where you want to see many devices at once.

#### Full Widget
An expanded view showing:
- All mini widget information
- Motor speed (RPM), voltage, power, torque
- Temperature readings
- Quick action buttons (Start, Stop, Set Frequency)
- Trend graph (historical frequency/current)

### 11.3 Quick Actions from the Widget

You can perform common actions directly from the SCADA widget without navigating to the full VFD detail page:

1. **Click** on the VFD widget on the SCADA screen.
2. A popup panel appears with quick action buttons.
3. **Click** the desired action (Start, Stop, Set Frequency, etc.).

### 11.4 Reading the Widget

- **Green outline/background:** VFD is running normally
- **Yellow outline/background:** VFD has a warning
- **Red outline/background:** VFD has a fault
- **Gray outline/background:** VFD is offline or stopped

---

## 12. Troubleshooting

This chapter helps you solve common problems. Start with the issue that best matches your situation.

### 12.1 "My VFD Shows as Offline"

When a VFD shows as "offline," it means the platform cannot communicate with it. Follow this checklist:

1. **Check the physical cables.** Is the communication cable (serial or network cable) securely connected at both ends? Look for loose connectors.
2. **Check the VFD power.** Is the VFD powered on? Check if its display panel is lit.
3. **Check network connectivity** (for Modbus TCP, Profinet, EtherNet/IP):
   - Can you ping the VFD's IP address from a computer on the same network?
   - Is the VFD connected to the correct network switch?
   - Is the Ethernet cable good? Try a different cable.
4. **Check serial line** (for Modbus RTU):
   - Is the RS-485 cable connected to the correct port?
   - Are the line termination resistors (120 ohm) installed at both ends of the cable?
   - Is any cable damaged or showing signs of corrosion?
5. **Check VFD settings.** Has someone changed the VFD's communication settings directly at the device panel? If so, update the settings in the platform to match.

### 12.2 "I Can't Connect to the VFD"

| Error Message | Most Likely Cause | What to Do |
|--------------|------------------|-----------|
| **"Connection timeout"** | Cable disconnected, wrong IP address, or port blocked by firewall | 1. Check all cable connections. 2. Verify the IP address and port number. 3. Check firewall rules. |
| **"CRC error"** | Baud rate, parity, or stop bits mismatch between platform and VFD | Check the VFD's communication settings on its own panel. They must exactly match the settings in the platform. |
| **"No response"** | Wrong Slave ID, VFD powered off, or missing cable termination | 1. Verify the Slave ID/Unit ID on the VFD panel. 2. Confirm the VFD has power. 3. Check that RS-485 line termination resistors (120 ohm) are installed. |
| **"Connection refused"** | Port is closed or another application is using it | 1. Verify the port number (Modbus TCP default: 502). 2. Check if another program is using the same port. |
| **"Network unreachable"** | IP address is not accessible | 1. Run a ping test. 2. Verify both devices are on the same subnet. 3. Check switch and cable connections. |

### 12.3 "My Change Set Was Rejected"

If a Checker rejected your change set:

1. **Read** the rejection reason. The Checker is required to explain why they rejected it.
2. **Go** to the change set detail page.
3. Common reasons for rejection:
   - The value is too aggressive (for example, ramp time too short)
   - The description does not explain the reason well enough
   - The change is not needed at this time
   - The wrong parameter was selected
4. **Edit** the change set based on the feedback.
5. **Resubmit** for approval.

### 12.4 "The Parameter Change Failed"

If a change set enters "Failed" status:

| Error | Cause | Solution |
|-------|-------|---------|
| **"Register not writable"** | The VFD's remote write permission is disabled | You need to enable remote control mode on the VFD itself. See the brand-specific instructions below. |
| **"Read-back mismatch"** | The value was written but the verification read returned a different value | 1. Try again -- it may be a timing issue. 2. Check if the parameter is locked on the VFD. 3. Verify the parameter is actually writable. |
| **"Motor running"** | You tried to change a parameter that requires the motor to be stopped | Stop the motor first (send a STOP command), then retry the change set. |
| **"Value out of range"** | The value you entered is outside the allowed range | Check the parameter's valid range and enter a value within it. |
| **"Device offline"** | Communication was lost while trying to apply changes | See section 12.1 above for offline troubleshooting. |

### 12.5 "I Need to Rollback Changes"

To undo a change set that was already applied:

1. **Go** to the VFD device's change set history.
2. **Find** the change set you want to undo (it must be in APPLIED or VERIFIED status).
3. **Click** "Rollback."
4. **Type** a reason for the rollback.
5. A new change set is created with the original values.
6. This rollback change set goes through the normal approval process.

For emergencies where you cannot wait for approval:
1. **Click** "Emergency Rollback."
2. **Type** a mandatory reason.
3. Changes are undone immediately.

### 12.6 Enabling Remote Access on Your VFD

Each VFD brand requires specific settings to be enabled on the physical device before the platform can control it. Below are the steps for each brand. You (or your electrician) will need to do these at the VFD's own control panel.

#### Danfoss FC Series
1. **Go to** parameter P8-01 on the VFD panel.
2. **Set** it to "FC Protocol" or Bus Control mode (value: 2).
3. **Go to** P8-02 and set the control word source to "RS485" or "FC Port."
4. **Verify** P8-30 (baud rate is set to match the platform, default 9600).
5. **Verify** P8-31 (Modbus address matches the platform, default 1).
6. **Verify** P8-32 (parity matches the platform).

#### ABB ACS Series
1. **Go to** Parameter Group 10 and select the control source.
2. **Set** External 1 or External 2 to "Fieldbus."
3. **Go to** Parameter Groups 51-53 and configure fieldbus communication settings.
4. **Set** the Modbus address and communication parameters to match the platform.
5. **Enter** motor data in Parameter Group 99.

#### Siemens G120 Series
1. **Set** P0700 to 5 (USS) or 6 (Modbus) for command source.
2. **Set** P1000 to 5 (USS) or 6 (Modbus) for frequency setpoint source.
3. **Set** P2010 to the desired Modbus address.
4. **Set** P2011 to the correct baud rate.
5. **Set** P2012 to the correct parity.

#### Schneider Altivar Series
1. **Verify** that the communication module is physically installed.
2. **Set** the Cmd/Ref channel to "Fieldbus."
3. **Configure** the Modbus address and communication parameters.
4. **Enable** Standard Modbus profile mode.

#### Yaskawa Series
1. **Set** b1-01 to "MEMOBUS/Modbus" for the reference source.
2. **Set** b1-02 to "MEMOBUS/Modbus" for the run command source.
3. **Enter** the Modbus slave address in H5-01.
4. **Set** the communication speed in H5-02.
5. **Set** the parity in H5-03.

#### Delta VFD Series
1. **Set** Pr.09-00 to the desired Modbus address.
2. **Set** Pr.09-01 to the correct communication speed.
3. **Set** Pr.09-04 to the correct communication protocol.
4. **Set** Pr.00-21 to "RS-485" for the control source.

#### Mitsubishi FR Series
1. **Set** Pr.117 to the desired RS-485 station number.
2. **Set** Pr.118 to the correct communication speed.
3. **Set** Pr.119 to the correct stop bits and parity.
4. **Set** Pr.120 to the communication timeout.
5. **Set** Pr.338 to "RS-485" for the command source.
6. **Set** Pr.339 to "RS-485" for the speed command source.

#### Rockwell PowerFlex Series
1. **Set** P046 (Speed Reference) to "Communication."
2. **Set** P047 (Start Source) to "Communication."
3. For EtherNet/IP: Configure the EtherNet/IP module.
4. For Modbus: Configure P033 and P034.

### 12.7 Common Error Messages and What They Mean

| Error Message | What It Means | What to Do |
|--------------|--------------|-----------|
| "Maker-Checker violation" | You are trying to approve a change set that you created. The same person cannot both create and approve. | Ask a different TENANT_ADMIN user to approve the change set. |
| "Active change set exists" | There is already another change set in progress for this device. Only one active (non-draft) change set per device is allowed. | Wait for the existing change set to complete, cancel it, or have it rejected. |
| "Insufficient permissions" | Your user role does not have access to this action. | You need MODULE_MANAGER to create change sets, TENANT_ADMIN to approve them. Contact your administrator. |

### 12.8 When to Call Support

Contact your system administrator or technical support if:

- You have tried all the troubleshooting steps and the problem persists
- You see error messages not listed in this guide
- Multiple VFDs go offline at the same time (this could indicate a network or gateway problem)
- You suspect a security breach (unauthorized changes appearing in the audit log)
- The platform itself is not loading or responding

**Summary: Troubleshooting**

> Most problems are caused by mismatched communication settings, loose cables, or permission issues. Always check the simple things first (cables, power, settings) before escalating to technical support.

---

## 13. Quick Reference Card

### Most Common Tasks

| Task | Where to Go | Steps |
|------|------------|-------|
| Start a motor | Device detail > Command Panel | Click Start > Confirm |
| Stop a motor | Device detail > Command Panel | Click Stop |
| Change speed | Device detail > Command Panel | Click Set Frequency > Enter value > Confirm |
| Emergency stop | Device detail (any page) | Click Emergency Stop (big red button) |
| View live data | Device detail > Monitoring tab | Data updates automatically |
| Change a setting | Device detail > Programming tab | Select group > Enter new value > Submit for approval |
| Check audit log | Device detail > Audit Log tab | Filter by date, parameter, or user |
| Add a new VFD | VFD Management > Add New VFD | Follow the 6-step wizard |

### Status Color Meanings

| Color | Meaning |
|-------|---------|
| **Green** | Everything is working normally (Ready, Running, At Reference) |
| **Yellow** | Attention needed (Warning, Thermal Warning, Current Limit) |
| **Red** | Problem -- action required (Fault, Trip Lock) |
| **Gray** | Device is offline or powered down |

### Risk Level Meanings

| Color | Level | Meaning |
|-------|-------|---------|
| **Green** | LOW | Safe to change |
| **Yellow** | MEDIUM | Be careful |
| **Orange** | HIGH | Significant impact, may require motor stop |
| **Red** | CRITICAL | Dangerous, could damage equipment |

### User Roles Quick Reference

| Action | VIEWER | OPERATOR | MODULE_MANAGER | TENANT_ADMIN |
|--------|--------|----------|----------------|--------------|
| View parameters and logs | Yes | Yes | Yes | Yes |
| Start/Stop motors | No | Yes | Yes | Yes |
| Create change sets | No | No | Yes | Yes |
| Approve/reject change sets | No | No | No | Yes |
| Emergency rollback | No | No | Yes | Yes |
| Create automation rules | No | No | No | Yes |
| Enable/disable automation rules | No | No | Yes | Yes |

### Glossary of Terms

| Term | Simple Explanation |
|------|-------------------|
| **VFD (Variable Frequency Drive)** | A device that controls how fast a motor spins. Also called an "inverter" or "drive." |
| **Frequency (Hz)** | The speed of the electrical signal sent to the motor. Higher Hz = faster motor. |
| **Current (Amps)** | The amount of electricity flowing through the motor. Higher current = motor working harder. |
| **Voltage (Volts)** | The electrical pressure pushing current through the motor. |
| **RPM** | Revolutions Per Minute -- how many times the motor shaft spins each minute. |
| **Ramp** | The gradual speeding up or slowing down of a motor. "Ramp up" = speed up, "Ramp down" = slow down. |
| **Parameter** | A setting stored in the VFD's memory that controls its behavior. |
| **Register** | A specific memory location inside the VFD where a parameter value is stored. |
| **Modbus** | A communication protocol (language) used to talk to industrial devices. |
| **Slave ID / Unit ID** | A unique address number (1-247) assigned to each VFD on a communication line. |
| **Baud Rate** | The speed of serial communication, measured in bits per second. Common values: 9600, 19200. |
| **Parity** | An error-checking method used in serial communication. Options: None, Even, Odd. |
| **PID** | Proportional-Integral-Derivative controller -- an algorithm that automatically adjusts motor speed to maintain a target value (like temperature or pressure). |
| **V/f (Volts per Frequency)** | The ratio of voltage to frequency sent to the motor. Controls motor efficiency at different speeds. |
| **Nameplate** | The metal label on a motor showing its electrical ratings (power, voltage, current, speed). |
| **Maker-Checker** | A safety process where one person proposes a change and a different person approves it. |
| **Change Set** | A package of one or more parameter changes managed as a group. |
| **Rollback** | Undoing a change by restoring the previous values. |
| **Audit Trail** | A permanent record of every change -- who, what, when, and why. Cannot be deleted. |
| **Trip** | When the VFD stops the motor due to a fault (error condition). |
| **Cooldown** | The minimum waiting time before an automation rule can trigger again. |
| **Soft Start** | Gradually increasing motor speed instead of starting at full speed. Reduces startup current and mechanical stress. |
| **Water Hammer** | A dangerous pressure surge in pipes caused by suddenly stopping a pump. Can damage pipes and valves. |
| **Auto-Tune** | A process where the VFD measures the motor's characteristics to optimize its control settings. |

---

*This guide was written for the Aquaculture SaaS Platform V1.0. For questions or support, contact your system administrator or technical support team.*
