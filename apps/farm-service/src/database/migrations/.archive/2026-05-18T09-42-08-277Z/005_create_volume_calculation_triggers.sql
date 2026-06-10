-- Migration: 005_create_volume_calculation_triggers
-- Description: Automatic volume calculation triggers for Tank and Pond
-- Date: 2024-11-29

-- =====================================================
-- TANK VOLUME CALCULATION
-- =====================================================

-- Tank volume trigger function
CREATE OR REPLACE FUNCTION calculate_tank_volume()
RETURNS TRIGGER AS $$
BEGIN
  -- Validation: Depth must be positive
  IF NEW.depth IS NULL OR NEW.depth <= 0 THEN
    RAISE EXCEPTION 'Tank depth must be greater than 0';
  END IF;

  -- Calculate volume based on tank type
  CASE NEW.tank_type
    WHEN 'CIRCULAR' THEN
      -- Circular tank: V = π × r² × h
      IF NEW.diameter IS NULL OR NEW.diameter <= 0 THEN
        RAISE EXCEPTION 'Diameter is required for circular tanks and must be greater than 0';
      END IF;
      NEW.volume := PI() * POWER(NEW.diameter / 2, 2) * NEW.depth;

    WHEN 'RECTANGULAR', 'RACEWAY', 'D_END' THEN
      -- Rectangular/Raceway: V = L × W × H
      IF NEW.length IS NULL OR NEW.length <= 0 THEN
        RAISE EXCEPTION 'Length is required for rectangular/raceway tanks and must be greater than 0';
      END IF;
      IF NEW.width IS NULL OR NEW.width <= 0 THEN
        RAISE EXCEPTION 'Width is required for rectangular/raceway tanks and must be greater than 0';
      END IF;
      NEW.volume := NEW.length * NEW.width * NEW.depth;

    ELSE
      -- Other types: require manual volume or use basic calculation
      IF NEW.volume IS NULL OR NEW.volume <= 0 THEN
        IF NEW.length IS NOT NULL AND NEW.width IS NOT NULL THEN
          NEW.volume := NEW.length * NEW.width * NEW.depth;
        ELSIF NEW.diameter IS NOT NULL THEN
          NEW.volume := PI() * POWER(NEW.diameter / 2, 2) * NEW.depth;
        ELSE
          RAISE EXCEPTION 'Volume must be provided for tank type: %', NEW.tank_type;
        END IF;
      END IF;
  END CASE;

  -- Round to 2 decimal places
  NEW.volume := ROUND(NEW.volume::numeric, 2);

  -- Calculate max density if not set
  IF NEW.max_density IS NULL OR NEW.max_density <= 0 THEN
    -- Default max density: 30 kg/m³ (configurable per species later)
    NEW.max_density := 30;
  END IF;

  -- Calculate max biomass if not set
  IF NEW.max_biomass IS NULL OR NEW.max_biomass <= 0 THEN
    NEW.max_biomass := NEW.volume * NEW.max_density;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- POND VOLUME CALCULATION
-- =====================================================

-- Pond volume trigger function
CREATE OR REPLACE FUNCTION calculate_pond_volume()
RETURNS TRIGGER AS $$
BEGIN
  -- Validation: Surface area must be positive
  IF NEW.surface_area IS NULL OR NEW.surface_area <= 0 THEN
    RAISE EXCEPTION 'Pond surface area must be greater than 0';
  END IF;

  -- Validation: Average depth must be positive
  IF NEW.avg_depth IS NULL OR NEW.avg_depth <= 0 THEN
    RAISE EXCEPTION 'Pond average depth must be greater than 0';
  END IF;

  -- Calculate volume: V = Surface Area × Average Depth
  NEW.volume := NEW.surface_area * NEW.avg_depth;

  -- Round to 2 decimal places
  NEW.volume := ROUND(NEW.volume::numeric, 2);

  -- Calculate max density if not set
  IF NEW.max_density IS NULL OR NEW.max_density <= 0 THEN
    -- Default max density: 15 kg/m³ for ponds (lower than tanks due to natural conditions)
    NEW.max_density := 15;
  END IF;

  -- Calculate max biomass if not set
  IF NEW.max_biomass IS NULL OR NEW.max_biomass <= 0 THEN
    NEW.max_biomass := NEW.volume * NEW.max_density;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- BIOMASS VALIDATION FUNCTIONS
-- =====================================================

-- Validate biomass doesn't exceed capacity
CREATE OR REPLACE FUNCTION validate_biomass_capacity()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if current biomass exceeds max biomass
  IF NEW.current_biomass > NEW.max_biomass THEN
    RAISE WARNING 'Current biomass (% kg) exceeds max biomass (% kg) for %',
      NEW.current_biomass, NEW.max_biomass, TG_TABLE_NAME;
  END IF;

  -- Check density
  IF NEW.volume > 0 AND (NEW.current_biomass / NEW.volume) > NEW.max_density THEN
    RAISE WARNING 'Current density (% kg/m³) exceeds max density (% kg/m³) for %',
      ROUND((NEW.current_biomass / NEW.volume)::numeric, 2), NEW.max_density, TG_TABLE_NAME;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- NOTES
-- =====================================================

/*
Triggers will be created when Tank and Pond tables are created:

-- For tanks table:
DROP TRIGGER IF EXISTS trg_calculate_tank_volume ON tanks;
CREATE TRIGGER trg_calculate_tank_volume
  BEFORE INSERT OR UPDATE OF diameter, length, width, depth, tank_type
  ON tanks
  FOR EACH ROW
  EXECUTE FUNCTION calculate_tank_volume();

DROP TRIGGER IF EXISTS trg_validate_tank_biomass ON tanks;
CREATE TRIGGER trg_validate_tank_biomass
  BEFORE INSERT OR UPDATE OF current_biomass
  ON tanks
  FOR EACH ROW
  EXECUTE FUNCTION validate_biomass_capacity();

-- For ponds table:
DROP TRIGGER IF EXISTS trg_calculate_pond_volume ON ponds;
CREATE TRIGGER trg_calculate_pond_volume
  BEFORE INSERT OR UPDATE OF surface_area, avg_depth
  ON ponds
  FOR EACH ROW
  EXECUTE FUNCTION calculate_pond_volume();

DROP TRIGGER IF EXISTS trg_validate_pond_biomass ON ponds;
CREATE TRIGGER trg_validate_pond_biomass
  BEFORE INSERT OR UPDATE OF current_biomass
  ON ponds
  FOR EACH ROW
  EXECUTE FUNCTION validate_biomass_capacity();
*/
