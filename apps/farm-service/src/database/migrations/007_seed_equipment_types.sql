-- Migration: 007_seed_equipment_types
-- Description: Seed initial equipment types data
-- Date: 2024-12-15

-- Tank types
INSERT INTO farm.equipment_types (id, name, code, description, category, icon, specification_schema, is_active, is_system, sort_order)
VALUES
    (uuid_generate_v4(), 'Fish Tank', 'fish-tank', 'Standard fish holding tank', 'tank', 'FiDroplet',
     '{"fields": [{"name": "volume", "label": "Volume", "type": "number", "unit": "L", "required": true}, {"name": "material", "label": "Material", "type": "select", "options": [{"value": "fiberglass", "label": "Fiberglass"}, {"value": "concrete", "label": "Concrete"}, {"value": "hdpe", "label": "HDPE"}, {"value": "stainless", "label": "Stainless Steel"}]}, {"name": "shape", "label": "Shape", "type": "select", "options": [{"value": "circular", "label": "Circular"}, {"value": "rectangular", "label": "Rectangular"}, {"value": "square", "label": "Square"}]}, {"name": "depth", "label": "Depth", "type": "number", "unit": "m"}, {"name": "diameter", "label": "Diameter", "type": "number", "unit": "m"}]}',
     true, true, 1),

    (uuid_generate_v4(), 'Raceway', 'raceway', 'Flow-through raceway system', 'tank', 'FiArrowRight',
     '{"fields": [{"name": "volume", "label": "Volume", "type": "number", "unit": "L", "required": true}, {"name": "length", "label": "Length", "type": "number", "unit": "m"}, {"name": "width", "label": "Width", "type": "number", "unit": "m"}, {"name": "depth", "label": "Depth", "type": "number", "unit": "m"}, {"name": "flowRate", "label": "Flow Rate", "type": "number", "unit": "m³/h"}]}',
     true, true, 2),

    (uuid_generate_v4(), 'Hatchery Tank', 'hatchery-tank', 'Tank for egg incubation and larvae', 'tank', 'FiCircle',
     '{"fields": [{"name": "volume", "label": "Volume", "type": "number", "unit": "L", "required": true}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "incubator", "label": "Incubator"}, {"value": "larvae", "label": "Larvae Tank"}, {"value": "nursery", "label": "Nursery"}]}]}',
     true, true, 3),

-- Pump types
    (uuid_generate_v4(), 'Water Pump', 'water-pump', 'Circulation and transfer pump', 'pump', 'FiActivity',
     '{"fields": [{"name": "flowRate", "label": "Flow Rate", "type": "number", "unit": "m³/h", "required": true}, {"name": "power", "label": "Power", "type": "number", "unit": "kW"}, {"name": "head", "label": "Head", "type": "number", "unit": "m"}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "centrifugal", "label": "Centrifugal"}, {"value": "submersible", "label": "Submersible"}, {"value": "axial", "label": "Axial"}]}]}',
     true, true, 10),

    (uuid_generate_v4(), 'Air Pump', 'air-pump', 'Air supply pump for aeration', 'pump', 'FiWind',
     '{"fields": [{"name": "airFlow", "label": "Air Flow", "type": "number", "unit": "L/min", "required": true}, {"name": "pressure", "label": "Pressure", "type": "number", "unit": "bar"}, {"name": "power", "label": "Power", "type": "number", "unit": "kW"}]}',
     true, true, 11),

-- Filtration types
    (uuid_generate_v4(), 'Drum Filter', 'drum-filter', 'Mechanical drum filtration', 'filtration', 'FiFilter',
     '{"fields": [{"name": "meshSize", "label": "Mesh Size", "type": "number", "unit": "µm", "required": true}, {"name": "flowRate", "label": "Flow Rate", "type": "number", "unit": "m³/h"}, {"name": "drumDiameter", "label": "Drum Diameter", "type": "number", "unit": "m"}]}',
     true, true, 20),

    (uuid_generate_v4(), 'Biofilter', 'biofilter', 'Biological filtration system', 'filtration', 'FiLayers',
     '{"fields": [{"name": "mediaVolume", "label": "Media Volume", "type": "number", "unit": "L", "required": true}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "mbbr", "label": "MBBR"}, {"value": "trickling", "label": "Trickling Filter"}, {"value": "fluidized", "label": "Fluidized Bed"}]}, {"name": "surfaceArea", "label": "Surface Area", "type": "number", "unit": "m²"}]}',
     true, true, 21),

    (uuid_generate_v4(), 'Sand Filter', 'sand-filter', 'Sand bed filtration', 'filtration', 'FiGrid',
     '{"fields": [{"name": "filterArea", "label": "Filter Area", "type": "number", "unit": "m²", "required": true}, {"name": "flowRate", "label": "Flow Rate", "type": "number", "unit": "m³/h"}]}',
     true, true, 22),

-- Aeration types
    (uuid_generate_v4(), 'Blower', 'blower', 'Air blower for aeration', 'aeration', 'FiWind',
     '{"fields": [{"name": "airFlow", "label": "Air Flow", "type": "number", "unit": "m³/h", "required": true}, {"name": "pressure", "label": "Pressure", "type": "number", "unit": "mbar"}, {"name": "power", "label": "Power", "type": "number", "unit": "kW"}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "rotary", "label": "Rotary Vane"}, {"value": "regenerative", "label": "Regenerative"}, {"value": "centrifugal", "label": "Centrifugal"}]}]}',
     true, true, 30),

    (uuid_generate_v4(), 'Aerator', 'aerator', 'Surface or diffuser aerator', 'aeration', 'FiSun',
     '{"fields": [{"name": "oxygenTransfer", "label": "Oxygen Transfer Rate", "type": "number", "unit": "kg O₂/h"}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "paddlewheel", "label": "Paddlewheel"}, {"value": "diffuser", "label": "Diffuser"}, {"value": "venturi", "label": "Venturi"}, {"value": "surface", "label": "Surface"}]}]}',
     true, true, 31),

    (uuid_generate_v4(), 'Oxygen Cone', 'oxygen-cone', 'Pure oxygen injection system', 'aeration', 'FiTarget',
     '{"fields": [{"name": "capacity", "label": "Capacity", "type": "number", "unit": "kg O₂/h", "required": true}, {"name": "efficiency", "label": "Transfer Efficiency", "type": "number", "unit": "%"}]}',
     true, true, 32),

-- Feeding types
    (uuid_generate_v4(), 'Auto Feeder', 'auto-feeder', 'Automatic fish feeder', 'feeding', 'FiClock',
     '{"fields": [{"name": "hopperCapacity", "label": "Hopper Capacity", "type": "number", "unit": "kg", "required": true}, {"name": "feedRate", "label": "Feed Rate", "type": "number", "unit": "kg/h"}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "demand", "label": "Demand Feeder"}, {"value": "timed", "label": "Timed"}, {"value": "pendulum", "label": "Pendulum"}]}]}',
     true, true, 40),

    (uuid_generate_v4(), 'Feed Silo', 'feed-silo', 'Feed storage silo', 'feeding', 'FiDatabase',
     '{"fields": [{"name": "capacity", "label": "Capacity", "type": "number", "unit": "kg", "required": true}, {"name": "material", "label": "Material", "type": "select", "options": [{"value": "fiberglass", "label": "Fiberglass"}, {"value": "steel", "label": "Steel"}, {"value": "plastic", "label": "Plastic"}]}]}',
     true, true, 41),

-- Heating/Cooling types
    (uuid_generate_v4(), 'Heat Exchanger', 'heat-exchanger', 'Water heat exchanger', 'heating_cooling', 'FiThermometer',
     '{"fields": [{"name": "capacity", "label": "Heat Transfer Capacity", "type": "number", "unit": "kW", "required": true}, {"name": "material", "label": "Material", "type": "select", "options": [{"value": "titanium", "label": "Titanium"}, {"value": "stainless", "label": "Stainless Steel"}, {"value": "copper", "label": "Copper"}]}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "plate", "label": "Plate"}, {"value": "shell_tube", "label": "Shell & Tube"}]}]}',
     true, true, 50),

    (uuid_generate_v4(), 'Chiller', 'chiller', 'Water cooling chiller', 'heating_cooling', 'FiMinus',
     '{"fields": [{"name": "coolingCapacity", "label": "Cooling Capacity", "type": "number", "unit": "kW", "required": true}, {"name": "power", "label": "Power", "type": "number", "unit": "kW"}, {"name": "refrigerant", "label": "Refrigerant", "type": "text"}]}',
     true, true, 51),

    (uuid_generate_v4(), 'Heater', 'heater', 'Water heater', 'heating_cooling', 'FiPlus',
     '{"fields": [{"name": "heatingCapacity", "label": "Heating Capacity", "type": "number", "unit": "kW", "required": true}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "electric", "label": "Electric"}, {"value": "gas", "label": "Gas"}, {"value": "solar", "label": "Solar"}]}]}',
     true, true, 52),

-- Water Treatment types
    (uuid_generate_v4(), 'UV Sterilizer', 'uv-sterilizer', 'UV water sterilization', 'water_treatment', 'FiZap',
     '{"fields": [{"name": "power", "label": "UV Power", "type": "number", "unit": "W", "required": true}, {"name": "flowRate", "label": "Flow Rate", "type": "number", "unit": "m³/h"}, {"name": "dose", "label": "UV Dose", "type": "number", "unit": "mJ/cm²"}]}',
     true, true, 60),

    (uuid_generate_v4(), 'Ozone Generator', 'ozone-generator', 'Ozone production for disinfection', 'water_treatment', 'FiCloud',
     '{"fields": [{"name": "ozoneOutput", "label": "Ozone Output", "type": "number", "unit": "g/h", "required": true}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "corona", "label": "Corona Discharge"}, {"value": "uv", "label": "UV"}]}]}',
     true, true, 61),

    (uuid_generate_v4(), 'Protein Skimmer', 'protein-skimmer', 'Foam fractionation', 'water_treatment', 'FiTrendingUp',
     '{"fields": [{"name": "flowRate", "label": "Flow Rate", "type": "number", "unit": "m³/h", "required": true}, {"name": "airFlow", "label": "Air Flow", "type": "number", "unit": "L/min"}]}',
     true, true, 62),

    (uuid_generate_v4(), 'Degasser', 'degasser', 'Gas stripping column', 'water_treatment', 'FiMinusCircle',
     '{"fields": [{"name": "flowRate", "label": "Flow Rate", "type": "number", "unit": "m³/h", "required": true}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "packed", "label": "Packed Column"}, {"value": "cascade", "label": "Cascade"}]}]}',
     true, true, 63),

-- Monitoring types
    (uuid_generate_v4(), 'Multiparameter Probe', 'multiparameter-probe', 'Multi-sensor water quality probe', 'monitoring', 'FiCpu',
     '{"fields": [{"name": "parameters", "label": "Measured Parameters", "type": "multiselect", "options": [{"value": "temperature", "label": "Temperature"}, {"value": "ph", "label": "pH"}, {"value": "do", "label": "Dissolved Oxygen"}, {"value": "salinity", "label": "Salinity"}, {"value": "conductivity", "label": "Conductivity"}, {"value": "orp", "label": "ORP"}, {"value": "turbidity", "label": "Turbidity"}]}]}',
     true, true, 70),

    (uuid_generate_v4(), 'DO Sensor', 'do-sensor', 'Dissolved oxygen sensor', 'monitoring', 'FiActivity',
     '{"fields": [{"name": "range", "label": "Measurement Range", "type": "text"}, {"name": "accuracy", "label": "Accuracy", "type": "text"}]}',
     true, true, 71),

    (uuid_generate_v4(), 'pH Sensor', 'ph-sensor', 'pH measurement sensor', 'monitoring', 'FiDroplet',
     '{"fields": [{"name": "range", "label": "Measurement Range", "type": "text"}, {"name": "accuracy", "label": "Accuracy", "type": "text"}]}',
     true, true, 72),

    (uuid_generate_v4(), 'Temperature Sensor', 'temp-sensor', 'Water temperature sensor', 'monitoring', 'FiThermometer',
     '{"fields": [{"name": "range", "label": "Measurement Range", "type": "text"}, {"name": "accuracy", "label": "Accuracy", "type": "text"}]}',
     true, true, 73),

    (uuid_generate_v4(), 'Flow Meter', 'flow-meter', 'Water flow measurement', 'monitoring', 'FiNavigation',
     '{"fields": [{"name": "range", "label": "Flow Range", "type": "text", "required": true}, {"name": "pipeSize", "label": "Pipe Size", "type": "number", "unit": "mm"}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "magnetic", "label": "Magnetic"}, {"value": "ultrasonic", "label": "Ultrasonic"}, {"value": "mechanical", "label": "Mechanical"}]}]}',
     true, true, 74),

    (uuid_generate_v4(), 'Level Sensor', 'level-sensor', 'Water level measurement', 'monitoring', 'FiLayers',
     '{"fields": [{"name": "range", "label": "Measurement Range", "type": "text", "required": true}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "ultrasonic", "label": "Ultrasonic"}, {"value": "pressure", "label": "Pressure"}, {"value": "float", "label": "Float"}]}]}',
     true, true, 75),

-- Safety types
    (uuid_generate_v4(), 'Backup Generator', 'backup-generator', 'Emergency power generator', 'safety', 'FiPower',
     '{"fields": [{"name": "power", "label": "Power Output", "type": "number", "unit": "kW", "required": true}, {"name": "fuelType", "label": "Fuel Type", "type": "select", "options": [{"value": "diesel", "label": "Diesel"}, {"value": "gas", "label": "Natural Gas"}, {"value": "propane", "label": "Propane"}]}, {"name": "runtime", "label": "Runtime at Full Load", "type": "number", "unit": "hours"}]}',
     true, true, 80),

    (uuid_generate_v4(), 'Alarm System', 'alarm-system', 'Monitoring and alarm system', 'safety', 'FiBell',
     '{"fields": [{"name": "channels", "label": "Number of Channels", "type": "number"}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "standalone", "label": "Standalone"}, {"value": "networked", "label": "Networked"}]}]}',
     true, true, 81),

-- Other types
    (uuid_generate_v4(), 'Valve', 'valve', 'Control or shutoff valve', 'plumbing', 'FiDisc',
     '{"fields": [{"name": "size", "label": "Size", "type": "number", "unit": "mm", "required": true}, {"name": "type", "label": "Type", "type": "select", "options": [{"value": "ball", "label": "Ball Valve"}, {"value": "butterfly", "label": "Butterfly"}, {"value": "gate", "label": "Gate"}, {"value": "check", "label": "Check"}]}, {"name": "actuation", "label": "Actuation", "type": "select", "options": [{"value": "manual", "label": "Manual"}, {"value": "pneumatic", "label": "Pneumatic"}, {"value": "electric", "label": "Electric"}]}]}',
     true, true, 90),

    (uuid_generate_v4(), 'Net/Cage', 'net-cage', 'Fish containment net or cage', 'other', 'FiSquare',
     '{"fields": [{"name": "volume", "label": "Volume", "type": "number", "unit": "m³", "required": true}, {"name": "meshSize", "label": "Mesh Size", "type": "number", "unit": "mm"}, {"name": "material", "label": "Material", "type": "select", "options": [{"value": "nylon", "label": "Nylon"}, {"value": "hdpe", "label": "HDPE"}, {"value": "copper", "label": "Copper Alloy"}]}]}',
     true, true, 91)
ON CONFLICT (code) DO NOTHING;
