# SCADA System User Guide

**Version:** 1.0
**Last Updated:** 2026-03-27
**Platform:** RuFlo Aquaculture v3

---

## Table of Contents

1. [What is SCADA and Why Does Your Farm Need It?](#1-what-is-scada-and-why-does-your-farm-need-it)
2. [Getting Started with SCADA](#2-getting-started-with-scada)
3. [Viewing SCADA Screens (View Mode)](#3-viewing-scada-screens-view-mode)
4. [Controlling Equipment from SCADA](#4-controlling-equipment-from-scada)
5. [Understanding Widgets (The Building Blocks of SCADA)](#5-understanding-widgets-the-building-blocks-of-scada)
6. [Building Your First SCADA Screen (Edit Mode)](#6-building-your-first-scada-screen-edit-mode)
7. [Customizing Widget Appearance](#7-customizing-widget-appearance)
8. [Creating Animations](#8-creating-animations)
9. [Connecting Widgets to Live Data (Tag Binding In Detail)](#9-connecting-widgets-to-live-data-tag-binding-in-detail)
10. [Working with Multiple Screens](#10-working-with-multiple-screens)
11. [Alarms and Notifications on SCADA](#11-alarms-and-notifications-on-scada)
12. [Example SCADA Screens (Step-by-Step Tutorials)](#12-example-scada-screens-step-by-step-tutorials)
13. [Simulation Mode](#13-simulation-mode)
14. [Troubleshooting SCADA](#14-troubleshooting-scada)
15. [Quick Reference Card](#15-quick-reference-card)

---

## 1. What is SCADA and Why Does Your Farm Need It?

### 1.1 What is SCADA?

Imagine a digital map of your entire fish farm that shows you everything happening in real time -- water pumps running, temperatures, oxygen levels, feeding systems, tank levels, and more. That is what SCADA does.

SCADA stands for **Supervisory Control and Data Acquisition**. That is a long way of saying "a system that lets you watch and control your farm equipment from a computer screen."

Think of it like a car dashboard, but instead of showing your speed and fuel level, it shows you the status of every pump, valve, sensor, filter, and tank in your entire facility. And just like how you can turn your car's air conditioning on from the dashboard, SCADA lets you start pumps, open valves, and change settings -- all from one screen.

### 1.2 What Can You Do with SCADA?

Here is what SCADA gives you:

- **See everything at a glance.** View live data from all your sensors -- temperature, pH, dissolved oxygen, tank levels -- updated every few seconds.
- **Control equipment remotely.** Start or stop a pump, open or close a valve, or adjust a motor speed without walking to the equipment room.
- **Get instant alerts.** When something goes wrong (water too hot, oxygen too low, pump failure), SCADA shows you a bright red warning immediately.
- **Track trends over time.** See how your water temperature changed over the past 24 hours, 7 days, or 30 days with line charts.
- **Build custom displays.** Create your own visual screens that show exactly the information you need, arranged the way you want it.

### 1.3 A Real-World Example

Without SCADA, checking your farm means walking to each tank, reading each sensor manually, and going to the pump room to start or stop equipment.

With SCADA, you sit at your desk (or look at your phone), and you see all of this on one screen. You notice the oxygen level in Tank 3 is dropping, so you click a button to increase the aerator speed. Done -- no walking required.

> **Summary:** SCADA is a visual dashboard for your entire farm. It shows live data, lets you control equipment, and alerts you when something needs attention.

---

## 2. Getting Started with SCADA

### 2.1 How to Find SCADA in the Menu

1. **Open** your web browser (Chrome is recommended).
2. **Go to** the RuFlo Aquaculture platform by typing the address in your browser.
3. **Log in** with your username and password.
4. **Look** at the left side of the screen. You will see a menu with several sections.
5. **Click** on **Sensor Module** in the left menu.
6. **Click** on **Process Editor**.

You should now see the SCADA Builder screen. It has a toolbar across the top, a panel on the left side (this is where you pick widgets), and a large open area in the center (this is your canvas -- the space where you build your screens).

### 2.2 Understanding the Main Screen

When you first open SCADA Builder, here is what you will see:

- **Top toolbar:** A row of buttons at the very top. This is where you switch between modes, save your work, and access settings.
- **Left panel (Widget Palette):** A vertical panel on the left side listing all the available widgets (visual elements) you can add to your screen. Think of this as your toolbox.
- **Center area (Canvas):** The large white area in the middle. This is your workspace -- the place where you drag widgets and build your SCADA screen. It uses a 12-column by 8-row grid (like graph paper) to help you line things up neatly.
- **Right panel (Properties):** When you click on a widget, this panel appears on the right side showing you all the settings for that widget.
- **Bottom-right corner (Mini Map):** A small thumbnail view showing where you are on the canvas, useful when you are zoomed in.

### 2.3 The Three Modes

SCADA Builder has three modes (ways of working). Understanding these is important:

| Mode | What It Is For | What You Can Do |
|------|----------------|-----------------|
| **Edit Mode** | Building and changing screens | Add, move, resize, and delete widgets. Draw pipe connections. Change settings. |
| **Preview Mode** (also called View Mode) | Day-to-day monitoring and control | See live sensor data. Use control buttons and sliders to operate equipment. |
| **Simulation Mode** | Testing without affecting real equipment | See your screen with fake (simulated) data to test how everything looks and behaves. |

**How to switch between modes:**

1. **Look** at the top toolbar.
2. You will see buttons or a dropdown labeled with the current mode name.
3. **Click** the mode you want to switch to.

**What to expect:**
- When you switch to **Edit Mode**, the canvas grid becomes visible and widgets can be moved around.
- When you switch to **Preview Mode**, the grid disappears, widgets lock in place, and live data starts flowing in. Control buttons become active.
- When you switch to **Simulation Mode**, everything looks like Preview Mode, but the data is simulated (fake numbers that change automatically for testing).

> **Tip:** Your widget positions are saved when you switch modes. Nothing moves or gets lost when you go from Edit to Preview and back.

> **Summary:** Find SCADA under Sensor Module > Process Editor. The screen has a widget palette on the left, a canvas in the center, and properties on the right. Three modes let you edit, view live data, or simulate.

---

## 3. Viewing SCADA Screens (View Mode)

This chapter covers what you will do most often: looking at your SCADA screens to monitor your farm.

### 3.1 Navigating Between Screens

Your farm may have multiple SCADA screens -- for example, one for the main process, one for pump details, one for water quality.

To move between screens:

1. **Look** at the left panel. You will see a list of all available screens.
2. **Click** on the screen name you want to view.
3. The screen loads in the center area.

Alternatively, some screens have navigation buttons built into them (rectangular buttons with labels like "Go to Pump Station" or "Back to Main Screen"). **Click** these buttons to jump to related screens.

### 3.2 Understanding What the Colors Mean

Colors on SCADA screens are not decorative -- they carry meaning. Here is what each color tells you:

| Color | Meaning | What to Do |
|-------|---------|------------|
| **Green** | Everything is normal. Equipment is running correctly. | No action needed. |
| **Yellow** | Something needs attention soon, but it is not urgent. | Check the parameter. Plan to investigate. |
| **Orange** | A warning. Something is getting close to a problem. | Investigate soon. May need adjustment. |
| **Red** | Problem! Something is wrong and may need immediate action. | Take action. Check the alarm details. |
| **Gray** | Equipment is off, stopped, or not connected. | May be normal (equipment is off by design) or may need investigation. |
| **Blue** | Equipment is in maintenance mode, or this is informational data. | No urgent action needed. |
| **Purple** | Data communication or networking indicator. | Typically no action needed. |

These colors follow industrial standards (ANSI/ISA-101.01), so they are the same across the entire system.

### 3.3 Reading Numbers and Gauges

On your SCADA screen, you will see various ways that data is displayed:

- **Numbers:** Simple large digits showing a value, like "22.5 C" for temperature or "7.2" for pH. The unit (C, mg/L, Hz, etc.) is usually shown next to the number.
- **Gauges (round dials):** A semicircular dial with a needle pointing to the current value, like a speedometer. The colored bands on the gauge tell you whether the value is in the normal range (green) or approaching a problem (yellow, red).
- **Progress bars:** Horizontal bars that fill up to show a percentage, like a battery indicator. Used for tank levels, fill percentages, and similar values.
- **Tank level indicators:** A visual picture of a tank with animated water that rises and falls based on the actual tank level.

### 3.4 Understanding Flow Direction Arrows

On process screens, you will see lines connecting equipment. These represent pipes. When equipment is running, you may see animated dashes moving along the pipes -- this shows you the direction water (or air) is flowing.

- **Moving dashes going left to right** means flow is going from left to right.
- **No movement** on a pipe means there is no flow (the pump is off or the valve is closed).
- **Reverse movement** (right to left) can indicate reverse flow if configured.

### 3.5 Clicking on Equipment for More Details

When you see a piece of equipment on the SCADA screen (like a pump icon or a tank):

1. **Hover** your mouse over it. A tooltip (small box) will appear showing key information like the equipment name, current status, and recent readings.
2. **Click** on the equipment. A detail panel opens on the right side showing full information: equipment name, sensor data, alarm settings, and more.
3. Some equipment has a **"Go to Detail Screen"** button in the detail panel. **Click** it to see a full screen dedicated to that piece of equipment.

### 3.6 Using the Screen Tabs at the Top

If multiple screens are open, you may see tabs at the top of the canvas area (like browser tabs). **Click** a tab to switch to that screen. Each screen remembers your zoom level and scroll position, so when you come back, you pick up right where you left off.

> **Troubleshooting:** If a screen looks blank or is not loading, try refreshing your browser (press F5 or Ctrl+R). If the problem persists, check your internet connection and contact your system administrator.

> **Summary:** View Mode shows you live data with meaningful colors. Green means OK, red means problem. Click equipment for details. Navigate between screens using the side panel or built-in buttons.

---

## 4. Controlling Equipment from SCADA

### 4.1 Safety First

> **WARNING:** When you control equipment from SCADA, you are sending real commands to real machines. A pump will actually start. A valve will actually open. Always be sure of what you are doing before clicking a control button.

Before using any control features, know these rules:

- Most control actions require **confirmation** -- you will see a dialog box asking "Are you sure?" before the action is carried out.
- Some actions require a **PIN code** -- you must type a security code before the action proceeds.
- **Emergency Stop buttons** do NOT require confirmation (because in an emergency, every second counts). They activate when you press and hold for about 2 seconds.
- You can only control equipment if your user account has the right permissions. If a button appears grayed out, you may not have permission to use it.

### 4.2 Clicking a Pump to Start or Stop It

1. **Find** the pump on your SCADA screen. It might be shown as an equipment icon or a toggle switch (a switch that slides left and right).
2. **Click** the toggle switch or the Start/Stop button next to the pump.
3. **A confirmation dialog appears** asking "Are you sure you want to start/stop this pump?"
4. **Click** "Yes" or "Confirm" to proceed, or "Cancel" to abort.
5. **Wait** a moment. The pump icon should change color:
   - If you started it: it turns **green** and you may see flow animation on connected pipes.
   - If you stopped it: it turns **gray** and flow animation stops.

### 4.3 Changing a Setpoint (Like Target Temperature)

A setpoint is a target value -- for example, "I want the water temperature to be 22 degrees" or "I want the pump to run at 35 Hz."

To change a setpoint:

1. **Find** the slider (a horizontal bar with a draggable handle) or the numeric input box (a box where you can type a number) for the parameter you want to change.
2. For a **slider**: **Drag** the handle left or right to the desired value. The current value is displayed above or below the slider.
3. For a **numeric input**: **Click** the input box, **type** the new value using your keyboard, and **press** Enter.
4. If security is enabled, **a confirmation dialog appears**. **Click** "Confirm."
5. The new setpoint value is sent to the equipment.

### 4.4 Emergency Stop Buttons

Emergency Stop buttons are large, red, and hard to miss. They are designed to immediately stop all equipment in an emergency.

**How to use an Emergency Stop button:**

1. **Find** the large red button labeled "EMERGENCY STOP" on your SCADA screen.
2. **Press and hold** the button for about 2 seconds. (This "hold" requirement prevents accidental activation.)
3. The system immediately sends stop commands to all connected equipment.

> **WARNING:** Emergency Stop is a safety feature. Use it only in genuine emergencies. After an emergency stop, equipment must be manually restarted and checked before resuming normal operation.

### 4.5 What Happens When You Click a Control Button

Here is the sequence of events when you click any control button:

1. You click the button.
2. If a confirmation dialog is configured, it appears. You must confirm.
3. If a PIN is required, you must enter it.
4. The command is sent to the equipment via the system's communication channel.
5. The widget updates to reflect the new status (usually within 1-3 seconds).
6. Connected elements update too -- for example, if you start a pump, the pipe connected to it begins showing flow animation.

### 4.6 Permissions and Security Levels

Each control widget has a security level:

| Security Level | What It Means |
|----------------|---------------|
| **None** | The action executes immediately when you click. No questions asked. (Used only for non-critical actions.) |
| **Confirmation Required** | A dialog box appears asking "Are you sure?" You must click "Yes" to proceed. (Recommended for most controls.) |
| **PIN Required** | You must type a numeric PIN code before the action proceeds. (Used for critical operations like VFD programming.) |

If you do not have permission to control a particular piece of equipment, the control widget will either be hidden or grayed out.

> **Tip:** Control widgets only work in **Preview Mode** (live data mode). If you are in Edit Mode, you can see the control widgets, but clicking them will not do anything.

> **Summary:** SCADA lets you start/stop equipment and change settings. Most actions require confirmation. Emergency Stop does not need confirmation but requires a 2-second hold. Control widgets only work in Preview Mode.

---

## 5. Understanding Widgets (The Building Blocks of SCADA)

### 5.1 What is a Widget?

A widget is a small visual element on your SCADA screen. Think of widgets like building blocks or LEGO pieces -- you pick the ones you need and arrange them on your screen to create your dashboard.

Each widget does one thing well. A gauge shows a dial reading. A button lets you start a pump. A chart shows data over time. A tank picture shows the water level. You combine many widgets to create a complete SCADA screen.

The system has over **52 different types of widgets**. Do not worry -- you do not need to learn all of them right away. This section introduces every widget type so you know what is available.

### 5.2 Widget Categories

Widgets are organized into categories based on what they do:

| Category | What These Widgets Do | Examples |
|----------|----------------------|----------|
| **Display widgets** | Show you information (read-only -- you look but do not touch) | Gauge, Numeric Display, Status Indicator, Tank Level, Trend Chart, Progress Bar, Bar Chart, Pie Chart, Data Table |
| **Control widgets** | Let you control equipment (you interact with these) | Toggle Switch, Slider, Numeric Input, Push Button, Emergency Stop, Dropdown Select, Knob |
| **Equipment widgets** | Pictures of physical equipment that change appearance based on status | Pumps, Valves, Tanks, Filters, Feeders, Heat Exchangers |
| **Alarm widgets** | Show warnings and alerts | Alarm Banner, Alarm List |
| **Calibration widgets** | Guide sensor calibration | Calibration Wizard, Calibration History, Calibration Status |
| **Navigation and Info widgets** | Help you move between screens and show static information | Screen Link, Static Text, Scheduler, Video Stream, Map View, IFrame |
| **Shape widgets** | Basic drawing shapes for decoration and diagrams | Rectangle, Circle, Ellipse, Line, Polygon, Triangle, Diamond, Arrow, Path, SVG Text |
| **Advanced SVG widgets** | Sophisticated animated graphics (FUXA widgets) | FUXA Widget (animated pumps, valves, tanks with 6-state animation) |
| **VFD Programmer** | Remote VFD parameter programming | VFD Programmer Widget |

### 5.3 Display Widgets -- Showing You Information

These widgets display data. They do not let you change anything; they just show you what is happening.

#### Gauge (Round Dial)

**What it looks like:** A semicircular dial with a needle, like a speedometer or a pressure gauge on a water tank. The needle points to the current value. Colored bands on the dial show you whether the value is in a safe range.

**What it shows:** Any numeric value -- temperature, pressure, pH, dissolved oxygen, motor current, speed, and more.

**Typical size:** 3 columns by 3 rows (about 360 by 300 pixels).

**Key settings:**
- Tag (which sensor to read from)
- Min and Max values (the range of the dial)
- Unit (what is being measured -- degrees C, mg/L, Hz, etc.)
- Decimal places (how many digits after the decimal point)
- Color zones (bands of color on the dial -- for example, blue for cold, green for normal, red for too hot)

---

#### Numeric Display (Simple Number)

**What it looks like:** A large, clear number with a label above it and a unit next to it. For example: "pH Value: 7.21" or "Temperature: 22.5 C".

**What it shows:** Any single numeric value with high precision.

**Typical size:** 2 columns by 2 rows (about 240 by 200 pixels).

**Key settings:**
- Tag, Label, Unit, Decimal places.

**When to use it:** When you need to see an exact number rather than a rough reading on a dial. Great for pH, dissolved oxygen, and other values where precision matters.

---

#### Status Indicator (On/Off Light)

**What it looks like:** A colored circle or rectangle that changes color based on whether something is on or off (or in various states). Like the indicator lights on a car dashboard.

**What it shows:** Whether equipment is running, stopped, or in a fault state. Can also show multiple states using different colors.

**Typical size:** 2 columns by 2 rows.

**Key settings:**
- Tag (the equipment status signal)
- Active Color (color when on -- usually green)
- Inactive Color (color when off -- usually gray)
- ON Label and OFF Label (text shown for each state, like "Running" and "Stopped")
- Color Ranges (for equipment with more than two states -- for example: 0=gray/stopped, 1=green/running, 2=red/fault)

---

#### Tank Level (Visual Tank)

**What it looks like:** A picture of a tank with animated water inside. The water level rises and falls to match the real tank level. A wave animation makes it look realistic.

**What it shows:** How full a tank is, as a percentage or actual volume.

**Typical size:** 2 columns by 4 rows (tall and narrow, like a real tank).

**Key settings:**
- Tag (the level sensor), Label, Min/Max values, Unit (%, liters, cubic meters).

---

#### Trend Chart (Line Graph Over Time)

**What it looks like:** A line graph (like a stock market chart) with time on the horizontal axis and sensor values on the vertical axis. Multiple colored lines can show different parameters at once.

**What it shows:** How one or more sensor values have changed over time -- for example, temperature over the last 24 hours.

**Typical size:** 6 columns by 4 rows (wide, to show time clearly).

**Key settings:**
- Tags (one or more sensors to plot -- for example, temperature as a blue line, pH as a green line, dissolved oxygen as an orange line)
- Default Time Range (how far back to show -- 1 hour, 6 hours, 24 hours, 7 days, or 30 days)
- Show Grid (graph paper lines behind the chart)
- Show Legend (color-coded labels identifying each line)

---

#### Progress Bar (Horizontal Fill Bar)

**What it looks like:** A horizontal bar that fills from left to right, like a battery level indicator or a download progress bar. Can change color based on how full it is.

**What it shows:** Any percentage-based value -- tank fullness, motor load, filter capacity, and so on.

**Typical size:** 3 columns by 1 row (wide and short).

**Key settings:**
- Tag, Label, Min/Max, Color Zones (for example: 0-50% green, 50-80% yellow, 80-100% red).

---

#### Bar Chart (Vertical Bars)

**What it looks like:** A chart with vertical bars of different heights, like a bar graph you might see in a business presentation. Each bar represents a different data source.

**What it shows:** Statistical comparisons -- for example, energy consumption of each pump side by side.

**Typical size:** 4 columns by 3 rows.

---

#### Pie Chart (Circle Chart)

**What it looks like:** A circle divided into colored slices, where each slice represents a proportion of the total.

**What it shows:** Distribution of data -- for example, what percentage of total energy each system uses.

**Typical size:** 3 columns by 3 rows.

---

#### Data Table (Spreadsheet View)

**What it looks like:** A table with rows and columns, like a simple spreadsheet. Supports sorting and filtering.

**What it shows:** Detailed sensor data in table format -- good for viewing many values at once.

**Typical size:** 6 columns by 4 rows.

---

### 5.4 Control Widgets -- Letting You Control Equipment

These widgets send commands to your equipment. They only work in **Preview Mode** (the live mode). In Edit Mode, they appear but cannot be activated.

#### Toggle Switch (On/Off Switch)

**What it looks like:** A sliding switch that can be flipped between two positions -- like a light switch on a wall.

**What it does:** Sends an ON or OFF command to equipment. Perfect for starting/stopping a pump or opening/closing a valve.

**Typical size:** 2 columns by 2 rows.

**Key settings:**
- Tag (the equipment control signal)
- ON Label and OFF Label (for example: "Start" and "Stop")
- Security Level: None, Confirmation Required, or PIN Required

---

#### Slider (Draggable Bar)

**What it looks like:** A horizontal track with a draggable handle. Drag the handle left or right to change the value. The current value is displayed.

**What it does:** Sets a continuous value within a range. Perfect for adjusting motor speed, valve position, or temperature setpoints.

**Typical size:** 3 columns by 2 rows.

**Key settings:**
- Tag, Label, Min/Max, Step (how much the value changes per notch), Unit, Security Level.

---

#### Numeric Input (Type-a-Number Box)

**What it looks like:** A text box where you can type a number, with up/down arrow buttons for fine adjustment.

**What it does:** Lets you type in a precise value. Perfect for setting exact setpoints (like "set temperature to exactly 22.5 degrees").

**Typical size:** 2 columns by 2 rows.

**Key settings:**
- Tag, Label, Unit, Min/Max, Step, Security Level.

---

#### Push Button (Single-Action Button)

**What it looks like:** A rectangular button with a label, like buttons on a website.

**What it does:** Sends a single command. Two modes are available:
- **Momentary** -- Active only while you hold the button down. Releases when you let go (like a doorbell).
- **Toggle** -- Each click changes the state (on, off, on, off...).

**Typical size:** 2 columns by 2 rows.

**Key settings:**
- Tag, Label, Button Mode (Momentary or Toggle), Value to Send, Security Level.

---

#### Emergency Stop (Big Red Button)

**What it looks like:** A large, bright red button labeled "EMERGENCY STOP." It stands out from everything else on the screen.

**What it does:** Immediately sends a stop command to all connected equipment. Designed for emergencies only.

**How to activate:** **Press and hold** for about 2 seconds. This hold requirement prevents accidental activation.

**Typical size:** 2 columns by 4 rows (large and impossible to miss).

> **WARNING:** The Emergency Stop button does NOT ask for confirmation. It activates immediately after the hold duration. This is by design -- in an emergency, every second counts.

---

#### Dropdown Select (Pick from a List)

**What it looks like:** A box that, when clicked, shows a list of options to choose from. Like a dropdown menu on a website form.

**What it does:** Lets you pick from predefined options -- for example, choosing an operating mode (Automatic / Manual / Maintenance).

**Typical size:** 2 columns by 2 rows.

**Key settings:**
- Tag, Label, Options (list of label-value pairs like "Automatic = 0", "Manual = 1", "Maintenance = 2").

---

#### Knob (Rotary Dial)

**What it looks like:** A round dial that you can click and drag to rotate, like the volume knob on a stereo.

**What it does:** Sets a value by rotating the knob. A visually intuitive way to adjust frequency, speed, or level.

**Typical size:** 2 columns by 2 rows.

**Key settings:**
- Tag, Label, Min/Max/Step, Start Angle/End Angle, Tick Count (number of marks around the dial), Colors.

---

### 5.5 Equipment Widgets -- Pictures of Your Farm Equipment

These widgets represent the physical equipment in your facility. They look like simplified pictures (symbols) of the actual equipment and change appearance based on the equipment's status.

#### Equipment Widget (General)

**What it looks like:** A symbolic picture of a piece of equipment -- a pump, valve, tank, filter, or heat exchanger. The symbol follows industrial standards (ISA-5.1) so it is recognizable to engineers worldwide.

**What it shows:** The current status of the equipment through color changes:
- **Green** = Running / Open (everything is normal)
- **Gray** = Stopped / Closed (equipment is off)
- **Red** = Fault (something is wrong)

**Supported equipment types include:**

**Pumps:**
- Centrifugal Pump (the most common type in aquaculture)
- Gear Pump
- Diaphragm Pump
- Piston Pump
- Submersible Pump (a pump that sits underwater)
- Vacuum Pump

**Valves (devices that control flow in pipes):**
- Gate Valve (slides up and down to open/close)
- Ball Valve (rotates a ball with a hole in it)
- Butterfly Valve (rotates a disc)
- Globe Valve (moves a plug up and down)
- Check Valve (allows flow in one direction only)
- Relief Valve (opens automatically at high pressure, a safety device)
- Control Valve (adjustable position for precise flow control)
- Needle Valve (fine flow adjustment)
- Solenoid Valve (electrically operated)

**Tanks:**
- Vertical Tank (standing upright)
- Horizontal Tank (lying on its side)
- Conical Bottom Tank (with a cone-shaped bottom for draining)
- Pressure Vessel (sealed, pressurized container)
- Silo (tall storage container, used for feed)
- Mixing Tank (with a stirrer inside)

**Heat Exchangers (devices that heat or cool water):**
- Shell and Tube
- Plate Heat Exchanger
- Air Cooler
- Condenser
- Evaporator

**Key settings:**
- Equipment Type (set when you pick it from the palette)
- Tag (the status signal from the equipment)
- Label (your custom name, like "Feed Pump #1")
- Rotation (0, 90, 180, or 270 degrees)

---

#### Aquaculture-Specific Equipment Widgets

These are equipment widgets specifically designed for fish farming:

| Widget | What It Represents | Typical Size |
|--------|-------------------|--------------|
| **Feeder** | Fish feed distribution machine | 2x3 |
| **Clean Water Tank** | Treated clean water storage | 2x3 |
| **Dirty Water Tank** | Untreated wastewater collection | 2x3 |
| **MBBR** (Moving Bed Biofilm Reactor) | Biological filtration unit for removing ammonia and nitrite | 3x2 |
| **HEPA Filter** | Air filtration system | 3x2 |
| **Radial Filter** | Mechanical filter for separating solid particles | 2x3 |
| **Cornell Dual Drain** | Dual drain system for removing solid waste without harming fish | 4x3 |
| **Process View** | Full process flow diagram showing all equipment and connections in one view | 12x6 (full screen) |

---

### 5.6 Alarm Widgets

#### Alarm Banner

**What it looks like:** A horizontal strip across the top of the screen showing active alarms as scrolling text. Usually placed at the very top of every SCADA screen.

**Typical size:** 12 columns by 2 rows (full width across the top).

---

#### Alarm List

**What it looks like:** A table listing all active and recent alarms with details: time, source, priority level, and acknowledgment status.

**Typical size:** 6 columns by 4 rows.

---

### 5.7 Calibration Widgets

| Widget | What It Does | Typical Size |
|--------|-------------|--------------|
| **Calibration Wizard** | Guides you step by step through calibrating a sensor (pH, dissolved oxygen, conductivity) | 6x4 |
| **Calibration History** | Shows a table of past calibration records | 6x4 |
| **Calibration Status** | Summarizes the calibration state of your sensors (last calibration date, next due, validity) | 3x3 |

---

### 5.8 Navigation and Information Widgets

#### Screen Link (Navigation Button)

**What it looks like:** A clickable button or card that takes you to another SCADA screen when clicked. Can appear as a card (large, informative), a button (compact), or minimal (just text).

**Key settings:**
- Target Screen (which screen to go to)
- Label (button text, like "Go to Pump Station")
- Display Style: Card, Button, or Minimal
- Color and Icon

**Typical size:** 2 columns by 2 rows.

---

#### Static Text

**What it does:** Displays fixed text on the screen -- headings, labels, notes, warnings. Does not change based on data.

**Typical size:** 3 columns by 1 row.

---

#### Other Information Widgets

| Widget | What It Does | Typical Size |
|--------|-------------|--------------|
| **Scheduler** | Shows a schedule calendar for timed operations (pump schedules, feeding times) | 4x3 |
| **Video Stream** | Shows live video from IP cameras at your facility | 3x2 |
| **Map View** | Shows your facility location on a map (useful for multi-site operations) | 3x3 |
| **IFrame** | Embeds an external web page inside your SCADA screen (manufacturer documentation, weather, etc.) | 4x3 |

---

### 5.9 Shape Widgets (Drawing Shapes)

For custom diagrams, you can add basic geometric shapes to your canvas:

| Widget | Shape | Typical Size |
|--------|-------|-------------|
| **svgRect** | Rectangle | 2x2 |
| **svgCircle** | Circle | 2x2 |
| **svgEllipse** | Ellipse (oval) | 2x2 |
| **svgLine** | Straight line | 3x1 |
| **svgPolygon** | Multi-sided shape | 2x2 |
| **svgTriangle** | Triangle | 2x2 |
| **svgDiamond** | Diamond (rotated square) | 2x2 |
| **svgArrow** | Arrow | 3x2 |
| **svgPath** | Custom drawn path (freeform shape) | 4x3 |
| **svgText** | Text rendered as SVG (scalable text) | 2x1 |

Each shape can have its fill color, border color, border thickness, and transparency set. You can also bind (connect) a shape's color to a tag so it changes color based on live data.

---

#### Custom SVG

**What it does:** Lets you upload your own SVG (Scalable Vector Graphics) file -- for example, a custom equipment symbol, your company logo, or a technical drawing.

**Typical size:** 2x2 (but you can resize freely).

---

#### Raster Image

**What it does:** Displays a bitmap image (PNG, JPG) on the screen. Use for facility photographs, technical drawings, or background images.

**Typical size:** 3x3.

---

### 5.10 FUXA Widgets (Advanced Animated Graphics)

FUXA widgets are sophisticated animated equipment graphics that come from the FUXA open-source SCADA community. Unlike simple shape widgets, FUXA widgets contain built-in animation scripts that make them move and change realistically.

**What makes them special:**
- A pump widget actually spins when the pump is running.
- A valve widget opens and closes visually.
- A tank widget fills and empties with animated liquid.
- Each widget has **6 animation states** (off, starting, running, warning, alarm, maintenance) with different colors and animations for each.

**Typical size:** 2x2 (resizable up to 12x8).

You will learn more about FUXA widgets in [Chapter 8: Creating Animations](#8-creating-animations).

---

### 5.11 VFD Programmer Widget

VFD stands for **Variable Frequency Drive** -- it is a device that controls the speed of electric motors (like the motors in your pumps). The VFD Programmer widget lets you view and change VFD settings directly from the SCADA screen.

**What it looks like:** A compact card showing the VFD name, status, and key parameters. Clicking it opens a full panel with all programmable parameters.

**Key features:**
- View current VFD parameter values
- Create a "change set" (a group of parameter changes you want to make)
- Submit the change set for approval (Maker-Checker workflow -- a second person must approve changes before they take effect)
- Track pending changes with a badge indicator

**Parameter groups you can view and change:**
- Ramp Times (how quickly the motor speeds up and slows down)
- Frequency Limits (minimum and maximum motor speed)
- Motor Nameplate Data (motor specifications)
- Protection Settings (safety limits)
- PID Controller (automatic speed control based on a sensor reading)
- Input/Output Configuration
- Communication Settings
- Jog Parameters (slow-speed operation)
- V/f Control Curves (voltage/frequency relationship)
- Current Limits

> **Summary:** There are over 52 widget types organized into display, control, equipment, alarm, calibration, navigation, shape, FUXA, and VFD categories. You do not need to memorize all of them. Start with the basics (Gauge, Numeric Display, Toggle Switch, Equipment) and explore more as you need them.

---

## 6. Building Your First SCADA Screen (Edit Mode)

Now you are going to build a SCADA screen from scratch. Follow these steps exactly.

### Step 1: Switch to Edit Mode

1. **Open** the SCADA Builder (Sensor Module > Process Editor).
2. **Click** the **Edit Mode** button in the top toolbar.
3. You should now see the grid lines on the canvas and the Widget Palette on the left side.

### Step 2: Create a New Screen

1. **Click** the **"New Screen"** button in the top toolbar.
2. **Type** a name for your screen. For this tutorial, type: "My First Screen".
3. **Choose** a screen type from the dropdown:
   - `dashboard` -- for a general overview panel
   - `process` -- for a process flow diagram
   - `alarms` -- for an alarm monitoring screen
   - `trends` -- for trend charts
   - `calibration` -- for calibration tasks
   - `control` -- for a control panel
4. For this tutorial, **select** `dashboard`.
5. **Click** the **"Create"** button.

You should now see an empty canvas with grid lines. This is your blank slate.

### Step 3: Understand the Toolbar

The toolbar across the top has these key functions:

| Icon/Button | What It Does |
|------------|--------------|
| **New Screen** | Creates a new blank screen |
| **Save** | Saves your current screen |
| **Undo** (or Ctrl+Z) | Undoes your last action |
| **Redo** (or Ctrl+Y) | Redoes what you just undid |
| **Mode Selector** | Switches between Edit, Preview, and Simulation modes |
| **Canvas Settings** | Opens settings for grid visibility, snap-to-grid, and zoom level |

### Step 4: Add Your First Widget

1. **Look** at the Widget Palette on the left side of the screen. You will see categories like "Monitoring," "Control," "Equipment," and so on.
2. **Click** on the **"Monitoring"** category to expand it.
3. **Find** the **"Gauge"** widget in the list.
4. **Click and hold** on the Gauge widget, then **drag** it onto the canvas (the white grid area in the center).
5. **Release** the mouse button to drop it.

You should now see a gauge widget sitting on your canvas. It will show a default dial with no data connected yet.

> **Tip:** The widget automatically snaps to the grid, so it lines up neatly. This feature is called "Snap-to-Grid" and is on by default.

### Step 5: Connect the Widget to Real Data (Tag Binding)

Right now, your gauge is empty because it is not connected to any sensor data. Let us connect it.

**What is a "tag"?** A tag is a name for a specific piece of data -- like `pump_1.speed` or `tank_2.temperature`. It is how the system knows which sensor or device to display on your widget. Think of a tag like a channel on a radio -- each sensor broadcasts on its own channel, and you tune the widget to the right channel.

Here is how to bind (connect) a tag:

1. **Click** on your gauge widget on the canvas. The Properties panel appears on the right side.
2. **Find** the **"Tag"** field in the Properties panel.
3. **Click** the small **browse button** (magnifying glass icon or "..." button) next to the Tag field. This opens the **Tag Browser**.
4. The Tag Browser shows a list of available devices. **Click** on your device (for example, "Edge Device 001").
5. A list of available data channels appears. **Click** on the one you want (for example, "temperature_1").
6. The tag name is automatically filled in the Tag field.
7. **Close** the Tag Browser.

Your gauge is now connected to live data. When you switch to Preview Mode, it will show the actual temperature reading.

### Step 6: Configure the Widget

While the gauge is still selected and the Properties panel is open:

1. **Set Min and Max:** Type `0` in the Min field and `40` in the Max field. This sets the gauge scale to show values between 0 and 40.
2. **Set Unit:** Type `C` (for degrees Celsius) in the Unit field.
3. **Set Decimal Places:** Type `1` to show one decimal place (like 22.5).
4. **Add Color Zones:** Find the "Zones" section and click **"+ Add Zone"** to add colored bands:
   - Zone 1: Min=0, Max=15, Color=Blue (low temperature)
   - Zone 2: Min=15, Max=25, Color=Green (normal range)
   - Zone 3: Min=25, Max=40, Color=Red (high temperature -- danger!)

### Step 7: Position and Resize the Widget

1. To **move** the widget: **Click and drag** it to a new position on the canvas.
2. To **resize** the widget: **Hover** your mouse over one of the edges or corners of the widget. When you see a resize cursor (double arrow), **click and drag** to make it bigger or smaller.
3. The widget snaps to grid lines as you move and resize, helping you keep things aligned.

### Step 8: Save Your Screen

1. **Click** the **Save** button in the toolbar (or press Ctrl+S).
2. Your screen is now saved. You can safely close the browser and come back later.

### Step 9: Preview Your Screen

1. **Click** the **Preview Mode** button in the toolbar.
2. The grid disappears and your gauge now shows live data from the connected sensor.
3. The gauge needle moves to reflect the current temperature, and the colored zones show you at a glance whether the temperature is normal.

Congratulations! You have built your first SCADA screen.

> **Troubleshooting:** If the gauge shows "No Data," check that the tag is correctly bound (Step 5), that the edge device is online, and that the sensor is sending data. See [Chapter 14: Troubleshooting](#14-troubleshooting-scada) for more help.

> **Summary:** Create a new screen, drag widgets from the palette, connect them to sensor tags, configure their appearance, and preview to see live data. Save often!

---

## 7. Customizing Widget Appearance

### 7.1 Changing Colors

1. **Click** the widget you want to customize.
2. In the Properties panel on the right, **find** the color settings (these vary by widget type):
   - **Fill Color** or **Background Color** -- the main color of the widget
   - **Text Color** or **Font Color** -- the color of any text displayed
   - **Border Color** -- the color of the widget's outline
   - **Active Color / Inactive Color** -- for status indicators
3. **Click** the color box to open a color picker.
4. **Choose** your desired color, or type a hex code (like `#22c55e` for green).

### 7.2 Changing Fonts and Sizes

1. **Click** the widget.
2. In Properties, **find** "Font Size" -- this controls how large the text appears. Typical range is 8 to 24 pixels.
3. Some widgets also have a **Label** field where you can change the text shown above or below the widget.

### 7.3 Adding Borders

1. **Click** the widget.
2. In Properties, **find** "Border Radius" -- this controls how rounded the corners are. Set it to 0 for sharp corners or higher (like 10-20) for rounded corners.
3. **Border Color** and **Border Width** control the outline.

### 7.4 Setting Ranges for Gauges

For Gauge and Progress Bar widgets, setting the correct range is critical:

1. **Click** the gauge.
2. Set **Min** to the lowest value you expect (for temperature, this might be 0).
3. Set **Max** to the highest value you expect (for temperature, this might be 40).
4. The gauge scale automatically adjusts.

> **Tip:** If the gauge needle goes off the scale, your Min/Max values are too narrow. Increase the range.

### 7.5 Choosing Display Formats

1. **Decimals** controls how many digits appear after the decimal point. For pH, you might want 2 decimals (7.21). For temperature, 1 decimal (22.5) is usually enough.
2. **Unit** shows a label next to the value. Common units: `C` (Celsius), `mg/L` (milligrams per liter for dissolved oxygen), `Hz` (Hertz for frequency), `%` (percent), `bar` (pressure), `NTU` (turbidity).

### 7.6 Adding Labels and Descriptions

1. **Click** the widget.
2. In Properties, **find** the **Label** field.
3. **Type** a descriptive name, like "Main Tank Temperature" or "Feed Pump #1 Status."
4. The label appears on or near the widget, making it clear what the widget shows.

> **Tip:** Always label your widgets clearly. When someone else looks at your screen (or when you look at it months later), you want every widget to be immediately understandable.

> **Summary:** Use the Properties panel to change colors, fonts, borders, ranges, units, and labels. Good customization makes your screens easier to read and use.

---

## 8. Creating Animations

### 8.1 What is an Animation?

An animation makes something on your screen move or change based on real data. For example:

- A pump picture **spins** when the pump is running and stops when it turns off.
- A number **turns red** when the temperature gets too high.
- A warning icon **appears** only when there is an alarm.
- A tank picture **fills up** as the real tank fills with water.
- An equipment symbol **blinks** when there is a fault.

Animations make your SCADA screens feel alive and help you spot changes instantly.

### 8.2 Types of Animations

There are several animation types available:

| Animation Type | What It Does | Example |
|---------------|-------------|---------|
| **Color Change** | Changes the color of a widget based on a value | Temperature > 30 C: widget turns red |
| **Visibility** | Shows or hides a widget based on a condition | Alarm active: warning icon appears. Alarm cleared: icon disappears. |
| **Rotation** | Spins a widget (like a pump impeller) | Pump running: fan graphic spins continuously |
| **Fill Level** | Changes the fill amount of a widget | Tank 75% full: tank graphic shows 75% water |
| **Blinking** | Makes a widget flash on and off | Critical alarm: status indicator blinks rapidly |

### 8.3 Creating Your First Animation: Pump Status

Let us create a pump that turns green and spins when running, and turns gray when stopped.

1. **Add** an Equipment widget (Centrifugal Pump) to your canvas. Open the Widget Palette, find "Equipment," and **drag** a Centrifugal Pump onto the canvas.

2. **Click** the pump widget to select it.

3. In the Properties panel, **find** the **Tag** field.

4. **Click** the Tag Browser button and **select** `pump_1.status`.

5. The system automatically applies the following animation rules:
   - Tag value = 1 (Running): Pump turns **green** and rotates.
   - Tag value = 0 (Stopped): Pump turns **gray** and stops rotating.
   - Tag value = 2 (Fault): Pump turns **red**.

6. **Save** your screen.

7. **Switch** to Preview Mode to see the animation in action. If the real pump is running, you will see the pump icon in green, possibly with a rotation animation.

### 8.4 Creating a Temperature Color Change Animation

Let us make a gauge that shows different colors for different temperature ranges.

1. **Add** a Gauge widget to the canvas and bind it to a temperature tag (see Chapter 6 for how to do this).

2. **Click** the gauge to select it.

3. In Properties, **find** the **Zones** section.

4. **Click** "+ Add Zone" and configure three zones:
   - Zone 1: Min=0, Max=15, Color=Blue (low temperature -- cold)
   - Zone 2: Min=15, Max=25, Color=Green (normal temperature -- good)
   - Zone 3: Min=25, Max=40, Color=Red (high temperature -- danger)

5. **Save** and **preview**. The gauge now shows:
   - If the water is 12 degrees, the gauge needle is in the **blue** zone.
   - If the water is 22 degrees, the needle is in the **green** zone.
   - If the water is 30 degrees, the needle is in the **red** zone -- the operator immediately sees the problem.

### 8.5 Creating a Pipe Flow Animation

Pipes (connections between equipment) can show animated flow when a pump is running.

1. In Edit Mode, **draw** a connection (edge) from a pump's output handle to a tank's input handle. (See Chapter 6 if you are not sure how to draw connections.)

2. **Click** on the pipe (connection line) to select it.

3. In the Properties panel, **find** the **"Flow Config"** section.

4. **Set** these values:
   - **Tag Name:** Type the pump's running status tag, like `pump_1.status`.
   - **Flow Condition:** Select `boolean` (this means: animate when the tag value is true/1, stop when false/0).
   - **Flow Speed:** Set to `1.5` (seconds -- lower number = faster animation). A value of 1-2 seconds gives a realistic water flow appearance.

5. **Save** and **preview**. When the pump is running, you will see animated dashes moving along the pipe, showing the direction of water flow.

### 8.6 Common Animation Recipes

Here are ready-to-use animation configurations for common scenarios:

**Recipe 1: Tank fills based on level sensor**
- Widget: Tank Level
- Tag: `tank_1.level`
- Result: Tank graphic fills proportionally. At 50%, the tank appears half full.

**Recipe 2: Valve opens and closes**
- Widget: Equipment (Butterfly Valve)
- Tag: `valve_1.status`
- Values: 0 = closed (gray), 1 = open (green)

**Recipe 3: Warning icon appears during alarm**
- Widget: Status Indicator
- Tag: `system.alarm_active`
- Active Color: Red
- ON Label: "ALARM"
- OFF Label: (empty -- icon hidden or shows "OK")

**Recipe 4: Motor speed display changes color at high speed**
- Widget: Gauge
- Tag: `motor_1.speed`
- Zones: 0-30 Hz = Green, 30-45 Hz = Yellow, 45-50 Hz = Red

> **Troubleshooting:** If an animation is not working: (1) Make sure you are in Preview Mode, not Edit Mode. (2) Check that the tag is correctly bound. (3) Verify the tag is sending data (check for "No Data" messages). (4) Double-check the condition values.

> **Summary:** Animations make your screens dynamic and informative. Use color changes for status, rotation for running equipment, fill levels for tanks, and flow animation for pipes. Configure them through the Properties panel.

---

## 9. Connecting Widgets to Live Data (Tag Binding In Detail)

### 9.1 What is a Tag, Exactly?

A tag is a unique identifier for a specific piece of data from a sensor or device. Every sensor reading, equipment status signal, and control parameter has its own tag.

Here are some example tags and what they represent:

| Tag Name | What It Represents |
|----------|-------------------|
| `temperature_1` | Temperature sensor #1 reading |
| `ph_sensor` | pH measurement sensor |
| `pump_1.status` | Whether Pump #1 is running (1) or stopped (0) |
| `pump_1.speed` | How fast Pump #1 is running (in Hz) |
| `tank_1.level` | How full Tank #1 is (in percent) |
| `vfd_1.frequency` | The operating frequency of VFD #1 |
| `do_sensor` | Dissolved oxygen sensor reading |
| `pump_1.command` | The control signal to start/stop Pump #1 |

**Two kinds of tags:**
- **Read tags** provide data FROM a sensor or device TO your screen (you look at the value). Example: `temperature_1` tells you the current temperature.
- **Write tags** send commands FROM your screen TO a device (you send a value). Example: `pump_1.command` tells the pump to start or stop.

### 9.2 The Tag Browser

The Tag Browser is a built-in tool that helps you find the right tag.

**How to open it:**
1. **Click** a widget on the canvas.
2. In the Properties panel, **click** the browse button next to the **Tag** field.

**What you see:**
- A list of edge devices (the hardware boxes that connect sensors to the network).
- Click a device to see its channels (each channel is a tag).
- You can search by typing a name in the search box at the top.
- Recently used tags appear in a "Recent" list for quick access.
- Each tag shows its type: AI (Analog Input -- a sensor reading like temperature), AO (Analog Output -- a control value like speed setpoint), DI (Digital Input -- on/off status), DO (Digital Output -- on/off command).

### 9.3 How to Bind a Tag (Step by Step)

1. **Click** the widget on the canvas.
2. In the Properties panel, **find** the **Tag** field.
3. **Click** the browse button to open the Tag Browser.
4. **Navigate** to your device and channel, or **type** a search term.
5. **Click** on the desired tag.
6. The tag name appears in the Tag field.
7. **Close** the Tag Browser.
8. **Save** your screen.

The widget is now live. In Preview Mode, it will show real-time data from that tag.

### 9.4 Multiple Tags on One Widget

Some widgets support multiple tags:

- **Trend Chart:** You can add multiple tags to display several lines on one graph. **Click** the "+ Add Tag" button in the chart's Properties to add more. Each tag gets its own color.
- **FUXA Widget:** Each variable inside a FUXA widget can be bound to a different tag (per-variable binding). More on this in the Advanced Guide.

### 9.5 Expression Binding (Calculated Values)

For Gauge and Progress Bar widgets, instead of showing a tag value directly, you can show a calculated value using a formula.

**Use cases:**
- Unit conversion (Fahrenheit to Celsius)
- Averaging multiple sensors
- Scaling a raw value to a different range
- Threshold detection

This is configured in the "Expression Binding" field in the Properties panel. Ask your system administrator for help with formulas.

### 9.6 What to Do When a Tag Shows "No Data"

If a widget shows "No Data" or a dash (--) instead of a value, here is a checklist:

1. **Is the tag name correct?** Tag names are case-sensitive. `Pump1.Status` is different from `pump1.status`.
2. **Is the edge device online?** Check that the hardware device collecting sensor data is powered on and connected to the network.
3. **Is the sensor working?** The physical sensor might be disconnected or broken.
4. **Are you in the right mode?** Tags only show live data in Preview Mode or Simulation Mode. In Edit Mode, widgets do not display live data.
5. **Is the data type compatible?** Binding a text tag to a number widget (or vice versa) can cause display issues.

> **Summary:** Tags are unique names for sensor data. Use the Tag Browser to find and connect tags to widgets. Read tags show you data; write tags send commands. Check the troubleshooting list if you see "No Data."

---

## 10. Working with Multiple Screens

### 10.1 Why Multiple Screens?

A real fish farm has many systems: pumps, filters, tanks, feeding, water quality, energy monitoring. Trying to show everything on one screen would be overwhelming and slow. Instead, create separate screens for different purposes and link them together.

**Recommended screen hierarchy for a fish farm:**

```
Level 0: Facility Overview (the "big picture" screen)
  |
  +-- Level 1: Section Screens
  |     +-- RAS Main Process Screen
  |     +-- Water Quality Monitoring
  |     +-- Energy Monitoring
  |     +-- Feeding System
  |
  +-- Level 2: Detail Screens
        +-- Pump Station #1 Detail
        +-- Pump Station #2 Detail
        +-- Filter Detail
        +-- VFD Programming
```

### 10.2 Creating Navigation Buttons Between Screens

To let users jump from one screen to another:

1. In Edit Mode, **drag** a **Screen Link** widget from the Widget Palette onto your canvas.
2. In the Properties panel, **set** the **Target Screen** to the screen you want to navigate to.
3. **Type** a label, like "Go to Pump Station" or "Back to Main Screen."
4. **Choose** a display style:
   - **Card** -- a large, informative button with an icon
   - **Button** -- a compact rectangular button
   - **Minimal** -- just text (like a hyperlink)
5. **Save**.
6. In Preview Mode, **clicking** the Screen Link button takes you to the target screen.

### 10.3 Building a Screen Hierarchy

**On the main overview screen (Level 0):**
- Place simplified representations of each major system (a small pump icon, a small tank icon, etc.).
- Next to each system, place a Screen Link button that says "View Details" or similar.
- This screen gives a high-level view of the entire facility.

**On section screens (Level 1):**
- Show more detail about one system (for example, the Water Quality screen shows pH, temperature, dissolved oxygen gauges, and a trend chart).
- Include a **"Back to Overview"** Screen Link button in the top-left corner.

**On detail screens (Level 2):**
- Show full detail for a single piece of equipment (for example, a VFD control panel with all parameters, a fault history table, and control buttons).
- Include a **"Back"** button to return to the parent screen.

### 10.4 Screen Templates

If you often create screens with similar layouts (for example, every pump station has the same types of widgets), you can save a screen as a template and reuse it:

- **Dashboard template** -- general overview panel
- **Process template** -- standard process flow diagram
- **Alarm template** -- alarm monitoring screen
- **Control template** -- control panel

### 10.5 Importing and Exporting Screens

SCADA screens can be exported (saved as a file) and imported (loaded from a file). This is useful for:

- **Backing up** your screens
- **Copying** screens from one facility to another
- **Sharing** screen designs with colleagues

**To export:** Use the export function in the screen menu. You will get a JSON file.

**To import:** Use the import function and select the JSON file. Note that tag bindings will be empty after import -- you will need to rebind tags to the new facility's sensors.

> **Summary:** Create multiple screens organized by level (overview, section, detail). Use Screen Link widgets to navigate between them. Templates and import/export let you reuse designs.

---

## 11. Alarms and Notifications on SCADA

### 11.1 The Alarm Banner

The Alarm Banner is a horizontal strip that sits at the top of your SCADA screen. When an alarm is active, it displays the alarm message with a timestamp, source, and severity.

**What you see when an alarm is active:**
```
[!] ALARM | 14:32:05 | Pump #1 Overcurrent | F03 | [ACKNOWLEDGE]
```

This tells you: there is an alarm, it happened at 14:32:05, it is about Pump #1 having too much electrical current, the fault code is F03, and there is a button to acknowledge it.

### 11.2 Alarm Priorities

Not all alarms are equally urgent. The system uses priorities:

| Priority | Color | Sound | Example |
|----------|-------|-------|---------|
| **Critical (1)** | Flashing red | Continuous beep | Overcurrent, dangerously low dissolved oxygen |
| **High (2)** | Solid red | Intermittent beep | Temperature alarm |
| **Medium (3)** | Orange | Single beep | Temperature warning |
| **Low (4)** | Yellow | Silent | Maintenance reminder |
| **Info (5)** | Blue | Silent | System information message |

### 11.3 Acknowledging Alarms

When an alarm goes off, it keeps flashing and beeping until someone acknowledges it.

**To acknowledge an alarm:**

1. **Look** at the Alarm Banner at the top of the screen.
2. **Find** the alarm message.
3. **Click** the **"Acknowledge"** button next to the alarm.
4. **What happens:**
   - The sound stops.
   - The flashing stops.
   - The color remains (the alarm is still active, but acknowledged).
   - When the condition clears (for example, the temperature comes back to normal), the alarm automatically disappears.

### 11.4 Alarm History

All alarms are recorded in a database. You can view alarm history using the Alarm List widget, which shows:

- When the alarm started
- When it was acknowledged (and by whom)
- When it ended
- What caused it

### 11.5 Setting Up Alarm Thresholds

Alarm thresholds (the values that trigger alarms) are typically configured by your system administrator. Common examples for aquaculture:

| Parameter | Warning Threshold | Alarm Threshold |
|-----------|------------------|-----------------|
| Temperature | Above 28 C or below 18 C | Above 32 C or below 15 C |
| Dissolved Oxygen | Below 5.0 mg/L | Below 3.0 mg/L |
| pH | Below 6.5 or above 8.5 | Below 6.0 or above 9.0 |
| Turbidity | Above 5.0 NTU | Above 10.0 NTU |

> **Summary:** Alarms use colors and sounds to get your attention based on severity. Always acknowledge alarms by clicking the Acknowledge button. Alarm history keeps a complete record.

---

## 12. Example SCADA Screens (Step-by-Step Tutorials)

### Tutorial 1: Simple Pump Station Screen

**What you will build:** A screen showing one pump's status, speed, motor current, with a start/stop switch and a speed slider.

**What the finished screen looks like:** In the center, a pump icon that turns green when running and gray when stopped. To its right, three stacked displays: motor current (gauge), running speed (numeric display), and status (indicator light). Below the pump, a toggle switch for start/stop and a slider for speed adjustment.

**Step-by-step instructions:**

1. **Create** a new screen named "Pump Station #1" (type: `control`).

2. **Add a Status Indicator:**
   - **Drag** a Status Indicator from the Widget Palette to the top-left area of the canvas.
   - **Set** Tag: `pump_1.status`
   - **Set** ON Label: "RUNNING"
   - **Set** OFF Label: "STOPPED"
   - **Set** Active Color: Green
   - **Set** Inactive Color: Gray
   - **Add** Color Ranges: 0=Gray (Stopped), 1=Green (Running), 2=Red (Fault)

3. **Add a Gauge for Motor Current:**
   - **Drag** a Gauge to the right of the Status Indicator.
   - **Set** Tag: `pump_1.current`
   - **Set** Label: "Motor Current"
   - **Set** Min: 0, Max: 20
   - **Set** Unit: A (Amperes)
   - **Add** Zones: 0-10 Green (normal), 10-15 Yellow (warning), 15-20 Red (overload)

4. **Add a Numeric Display for Speed:**
   - **Drag** a Numeric Display below the gauge.
   - **Set** Tag: `pump_1.speed`
   - **Set** Label: "Running Speed"
   - **Set** Unit: Hz
   - **Set** Decimals: 1

5. **Add a Toggle Switch for Start/Stop:**
   - **Drag** a Toggle Switch to the bottom-left area.
   - **Set** Tag: `pump_1.command`
   - **Set** Label: "Pump Control"
   - **Set** ON Label: "START"
   - **Set** OFF Label: "STOP"
   - **Set** Security Level: Confirmation Required

6. **Add a Slider for Speed Adjustment:**
   - **Drag** a Slider to the right of the toggle switch.
   - **Set** Tag: `pump_1.frequency_setpoint`
   - **Set** Label: "Speed Setting"
   - **Set** Min: 0, Max: 50, Step: 0.5
   - **Set** Unit: Hz
   - **Set** Security Level: Confirmation Required

7. **Save** and **preview**. You should see live data flowing into all widgets. Try toggling the pump and adjusting the slider (with confirmation dialogs).

---

### Tutorial 2: Water Quality Dashboard

**What you will build:** A screen showing five water quality parameters as gauges, a trend chart below, and alarm threshold information.

**What the finished screen looks like:** Five gauges in a row across the top (pH, Dissolved Oxygen, Temperature, Salinity, Turbidity). Below them, a large trend chart showing the last 7 days. In the bottom-left, an alarm thresholds reference table.

**Step-by-step instructions:**

1. **Create** a new screen named "Water Quality" (type: `dashboard`).

2. **Add five Gauges across the top:**

   | Gauge # | Label | Tag | Min | Max | Unit | Zones |
   |---------|-------|-----|-----|-----|------|-------|
   | 1 | pH | `ph_sensor` | 4 | 10 | (none) | 4-6.5 Red, 6.5-8.5 Green, 8.5-10 Red |
   | 2 | Dissolved Oxygen | `do_sensor` | 0 | 15 | mg/L | 0-3 Red, 3-5 Yellow, 5-15 Green |
   | 3 | Temperature | `water_temp` | 0 | 40 | C | 0-15 Blue, 15-28 Green, 28-40 Red |
   | 4 | Salinity | `salinity_sensor` | 0 | 40 | ppt | 0-10 Blue, 10-25 Green, 25-40 Red |
   | 5 | Turbidity | `turbidity_sensor` | 0 | 20 | NTU | 0-5 Green, 5-10 Yellow, 10-20 Red |

3. **Add a Trend Chart below the gauges:**
   - **Drag** a Trend Chart widget to the area below the gauges. Make it wide (6-8 columns).
   - **Add** tags: `water_temp`, `ph_sensor`, `do_sensor`
   - **Set** Default Time Range: 7 Days
   - **Set** Show Grid: On
   - **Set** Show Legend: On

4. **Add a Static Text widget** in the bottom-left for reference:
   - **Type** threshold information: "pH Warning: 6.5-8.5 | Alarm: 6.0-9.0 | DO Warning: >5.0 | Alarm: >3.0"

5. **Save** and **preview**.

---

### Tutorial 3: Feeding System Control

**What you will build:** A screen showing three feed silos with level indicators, a conveyor belt representation, destination tanks, and a feeding schedule.

**Step-by-step instructions:**

1. **Create** a new screen named "Feeding System" (type: `control`).

2. **Add three Tank Level widgets** across the top (representing feed silos):
   - Silo 1: Tag = `silo_1.level`, Label = "2mm Pellet", Min=0, Max=100, Unit=%
   - Silo 2: Tag = `silo_2.level`, Label = "3mm Pellet"
   - Silo 3: Tag = `silo_3.level`, Label = "5mm Pellet"

3. **Add arrows** (svgArrow widgets) pointing downward from each silo to represent the feed flow.

4. **Add a horizontal Progress Bar** in the middle to represent the conveyor belt:
   - Tag = `conveyor.running`
   - Label = "Distribution Line"

5. **Add Feeder widgets** at the bottom to represent destination tanks (Tank A1, A2, B1, B2).

6. **Add a Data Table** in the lower section for the feeding schedule:
   - Columns: Time, Tank, Amount (kg), Silo, Status

7. **Add Numeric Displays** for daily statistics:
   - Today's total: Tag = `feed.daily_total`
   - Weekly total: Tag = `feed.weekly_total`
   - Stock remaining: Tag = `feed.stock_remaining`

8. **Save** and **preview**.

---

### Tutorial 4: VFD Motor Control Panel

**What you will build:** A comprehensive screen for controlling and monitoring a VFD-driven motor, including speed control, live parameter display, and VFD programming access.

**Step-by-step instructions:**

1. **Create** a new screen named "VFD Control - Pump #1" (type: `control`).

2. **Add four Gauges** for VFD monitoring (arrange in a 2x2 grid):
   - Frequency: Tag = `vfd_1.frequency`, Min=0, Max=50, Unit=Hz, Zones: 0-35 Green, 35-45 Yellow, 45-50 Red
   - Current: Tag = `vfd_1.current`, Min=0, Max=25, Unit=A
   - Torque: Tag = `vfd_1.torque`, Min=0, Max=100, Unit=%
   - Power: Tag = `vfd_1.power`, Min=0, Max=11, Unit=kW

3. **Add a Numeric Display panel** (right side) with six values:
   - Frequency: `vfd_1.frequency` (Hz)
   - Current: `vfd_1.current` (A)
   - Torque: `vfd_1.torque` (%)
   - Power: `vfd_1.power` (kW)
   - RPM: `vfd_1.rpm` (RPM)
   - Temperature: `vfd_1.temperature` (C)

4. **Add control widgets:**
   - Push Button "START": Tag = `vfd_1.start_command`, Security = Confirmation Required
   - Push Button "STOP": Tag = `vfd_1.stop_command`, Security = Confirmation Required
   - Push Button "RESET": Tag = `vfd_1.reset_command`, Security = PIN Required
   - Slider "Frequency Setting": Tag = `vfd_1.frequency_setpoint`, Min=0, Max=50, Step=0.5, Unit=Hz

5. **Add a Dropdown Select** for speed mode:
   - Tag = `vfd_1.speed_mode`
   - Options: "Fixed Speed" = 0, "PID Control" = 1, "Multi-Step" = 2

6. **Add a VFD Programmer widget** (if available):
   - **Drag** the VFD Programmer widget to the lower section.
   - **Set** VFD Device to your VFD.
   - This gives operators access to view and change VFD parameters with the Maker-Checker approval workflow.

7. **Add a Data Table** for fault history:
   - Shows recent VFD fault codes, descriptions, and resolution status.

8. **Save** and **preview**.

---

### Tutorial 5: Energy Monitoring Dashboard

**What you will build:** A screen showing energy consumption across all equipment, with bar charts, totals, and cost information.

**Step-by-step instructions:**

1. **Create** a new screen named "Energy Monitoring" (type: `dashboard`).

2. **Add a Bar Chart** (top section, full width):
   - Shows energy consumption (kWh) per equipment: Pump 1, Pump 2, Pump 3, Aerator, UV System, Filter, Dosing Pump.

3. **Add three Numeric Display panels** below the bar chart:
   - Total Energy: Today = `energy.daily_total`, Week = `energy.weekly_total`, Month = `energy.monthly_total`
   - Power Factor: `energy.power_factor`, Gauge with target line at 0.95
   - Cost: Today's cost, Monthly cost, Cost per kWh

4. **Add a Trend Chart** at the bottom:
   - Shows hourly power consumption (kW) over 24 hours.
   - Tag = `energy.total_power`
   - Time Range = 24 Hours

5. **Save** and **preview**.

> **Summary:** These five tutorials cover the most common SCADA screen types for aquaculture. Follow them step by step, and you will have a complete set of operational screens.

---

## 13. Simulation Mode

### 13.1 What is Simulation Mode?

Simulation Mode is like a practice area. It lets you test your SCADA screens with fake (simulated) data instead of real sensor data. This is useful because:

- You can test a new screen design without needing real equipment connected.
- You can simulate alarm scenarios to see what happens when values go out of range.
- You can verify that animations work correctly.
- You can use it for training new operators.

### 13.2 How to Enter Simulation Mode

1. **Open** your SCADA screen in the SCADA Builder.
2. **Click** the **Simulation Mode** button in the top toolbar.
3. The screen switches to simulation mode. Everything looks like Preview Mode, but the data is simulated.

### 13.3 What Happens in Simulation Mode

- Widgets display simulated values that change automatically or can be manually adjusted.
- Control widgets are active -- you can click buttons and move sliders to see how the screen responds.
- Animations run based on the simulated values.
- Alarms can trigger based on simulated values exceeding thresholds.
- **No real commands are sent to equipment.** This is completely safe.

### 13.4 Adjusting Simulated Values

In the Edit Mode properties of equipment widgets, you can set a **"Demo Status"** field to choose which state to simulate:

- Running
- Stopped
- Open
- Closed
- Fault

This lets you see what each equipment widget looks like in each state without needing the actual equipment.

### 13.5 Going Back to Live Mode

1. **Click** the **Preview Mode** button in the top toolbar to switch back to live data.
2. All widgets will now show real sensor data again.

> **Tip:** Always test new screens in Simulation Mode before deploying them for real use. It is much better to find problems with fake data than with real operations.

> **Summary:** Simulation Mode lets you test screens safely with fake data. No real equipment is affected. Use it for testing and training.

---

## 14. Troubleshooting SCADA

### Problem: "My widget shows 'No Data'"

**Checklist:**

1. **Are you in the right mode?** Widgets only show live data in Preview Mode or Simulation Mode. Switch from Edit Mode.
2. **Is the tag bound correctly?** Click the widget and check the Tag field in Properties. It should contain a valid tag name.
3. **Is the tag name spelled correctly?** Tag names are case-sensitive. `pump1.Status` and `pump1.status` are different.
4. **Is the edge device online?** Check that the hardware device collecting data is powered on and connected.
5. **Is the sensor working?** The physical sensor may be disconnected, broken, or out of calibration.
6. **Is MQTT connected?** The communication system (MQTT) between the edge device and the platform may be down. Contact your system administrator.

---

### Problem: "The screen will not load"

**Checklist:**

1. **Check your internet connection.** Try loading another web page.
2. **Refresh the browser.** Press F5 or Ctrl+R.
3. **Clear browser cache.** Press Ctrl+Shift+Delete and clear cached data.
4. **Try a different browser.** Chrome is recommended.
5. **Check with your administrator.** The server may be down for maintenance.

---

### Problem: "Animation is not working"

**Checklist:**

1. **Are you in Preview or Simulation Mode?** Animations do not run in Edit Mode.
2. **Is the tag bound?** The widget must have a tag connected to drive the animation.
3. **Is the tag sending data?** Check that the tag does not show "No Data."
4. **Is the animation configured correctly?** Check the animation settings in the Properties panel. Make sure conditions and values are set correctly.
5. **Are there too many widgets?** If you have more than 50 widgets on one screen, animations may slow down. Consider splitting the screen (see [Performance Tips](#9-3-performance-tips) below).
6. **Conflicting animation settings?** If a pipe has both the old `animated: true` flag and the new `flowConfig`, the `flowConfig` takes priority. Remove the old `animated` setting.

---

### Problem: "I accidentally deleted something"

**Solution:** Press **Ctrl+Z** immediately. This is the Undo function. You can press it multiple times to undo several actions.

If you saved after deleting, check if your system has version history. Contact your administrator about restoring a previous version.

---

### Problem: "The colors are wrong"

**Checklist:**

1. **Check the tag binding.** The widget may be bound to the wrong tag, showing values that do not match the expected color zones.
2. **Check the color zones.** Open Properties and verify the zone ranges match your expected values.
3. **Check the Color Ranges** on Status Indicator widgets. Make sure the value-to-color mappings are correct.

---

### Problem: "Equipment control buttons do not work"

**Checklist:**

1. **Are you in Preview Mode?** Control widgets only work in Preview Mode, not Edit Mode.
2. **Do you have permission?** Your user account may not have control access. Contact your administrator.
3. **Is the security confirmation working?** If a confirmation dialog appears but nothing happens after confirming, the communication link to the equipment may be down.
4. **Is the equipment physically enabled?** Some equipment has a local/remote switch. Make sure it is set to "Remote" to accept SCADA commands.

---

### Problem: "FUXA widget is not loading"

**Common errors:**

| Error Message | Cause | Solution |
|--------------|-------|----------|
| "Only .svg files are accepted" | Wrong file type uploaded | Make sure the file ends with `.svg` |
| "File too large" | SVG exceeds 1 MB limit | Optimize the SVG file (remove unnecessary elements) |
| "Invalid SVG file" | File does not start with `<svg>` or `<?xml>` | Use a valid SVG file |
| Widget appears blank | Script error inside the SVG | Check browser console (F12) for error messages |
| Variables not detected | Missing export markers | SVG must contain `//!export-start` and `//!export-end` markers |

---

### Problem: "Pipe connections look broken"

**Checklist:**

1. **Check connection points.** Source widgets need an output point; target widgets need an input point.
2. **Reset the path.** Right-click the pipe and select "Reset Path" to restore the default routing.
3. **Redraw the connection.** If all else fails, delete the broken pipe and draw a new one.
4. **Try a different routing mode.** For orthogonal (right-angle) pipes, try switching between "horizontal-first," "vertical-first," and "auto" routing modes.

> **Summary:** Most problems have simple solutions. Check the mode you are in, verify tag bindings, and ensure devices are online. Use Ctrl+Z to undo mistakes. When in doubt, contact your system administrator.

---

## 15. Quick Reference Card

### 15.1 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + Z` | Undo (reverse your last action) |
| `Ctrl + Y` | Redo (redo what you just undid) |
| `Ctrl + C` | Copy the selected widget |
| `Ctrl + V` | Paste the copied widget |
| `Delete` or `Backspace` | Delete the selected widget or connection |
| `Ctrl + A` | Select all widgets on the screen |
| `Ctrl + G` | Group selected widgets together (they move as one) |
| `Shift + Click` | Add to selection (select multiple widgets) |
| `Ctrl + Mouse Wheel` | Zoom in / Zoom out |
| `Right-Click` | Open context menu (copy, delete, lock, group options) |
| `Double-Click (Widget)` | Open detail panel for the widget |
| `Double-Click (Pipe Segment)` | Add a bend point to the pipe (orthogonal edges) |
| `Right-Click (Bend Point)` | Delete the bend point |
| `Click Empty Area` | Deselect everything |

### 15.2 Toolbar Icons

| Icon / Button | What It Does |
|--------------|--------------|
| New Screen | Creates a new blank SCADA screen |
| Save | Saves the current screen |
| Undo / Redo | Reverses or restores actions |
| Mode Selector | Switches between Edit, Preview, and Simulation modes |
| Canvas Settings | Controls grid visibility, snap-to-grid, and zoom |

### 15.3 Color Meanings (ANSI/ISA-101.01 Standard)

| Color | Hex Code | Meaning |
|-------|----------|---------|
| Red | #ef4444 | Critical alarm, emergency |
| Orange | #f97316 | High-priority warning |
| Yellow | #eab308 | Warning (low priority) |
| Green | #22c55e | Normal operation |
| Blue | #3b82f6 | Information, maintenance mode |
| Gray | #9ca3af | Off, stopped, disconnected |
| Purple | #7c3aed | Data/communication link |

### 15.4 Widget Types at a Glance

| Category | Widgets |
|----------|---------|
| Display | Gauge, Numeric Display, Status Indicator, Tank Level, Trend Chart, Progress Bar, Bar Chart, Pie Chart, Data Table |
| Control | Toggle Switch, Slider, Numeric Input, Push Button, Emergency Stop, Dropdown Select, Knob |
| Equipment | Centrifugal Pump, Gear Pump, Submersible Pump, Gate Valve, Ball Valve, Butterfly Valve, Control Valve, Vertical Tank, Horizontal Tank, Mixing Tank, and many more |
| Aquaculture | Feeder, Clean Water Tank, Dirty Water Tank, MBBR, HEPA Filter, Radial Filter, Cornell Dual Drain, Process View |
| Alarm | Alarm Banner, Alarm List |
| Calibration | Calibration Wizard, Calibration History, Calibration Status |
| Navigation | Screen Link, Static Text, Scheduler, Video Stream, Map View, IFrame |
| Shapes | Rectangle, Circle, Ellipse, Line, Polygon, Triangle, Diamond, Arrow, Path, SVG Text, Custom SVG, Raster Image |
| Advanced | FUXA Widget (animated SVG), VFD Programmer |

### 15.5 Common Tag Naming Patterns

| Pattern | Meaning | Example |
|---------|---------|---------|
| `{device}_{number}` | Simple sensor | `temperature_1` |
| `{device}.{property}` | Device with property | `pump_1.status` |
| `{device}.{property}` | Compound name | `vfd_1.frequency` |

### 15.6 Canvas Quick Reference

| Action | How |
|--------|-----|
| Zoom in/out | Ctrl + mouse wheel |
| Pan (scroll around) | Click and drag on empty canvas area |
| Show/hide grid | Canvas Settings > Show Grid |
| Enable/disable snap | Canvas Settings > Snap Enabled |
| View mini map | Look at bottom-right corner of canvas |

---

**This guide was written for the RuFlo Aquaculture Platform v3 SCADA Builder system.**

**If you have questions, contact your platform administrator or system integrator.**
