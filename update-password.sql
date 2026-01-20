UPDATE public.users
SET password = '$2b$10$MIM37b5k/gnFESqjf3GfoONluDXH34NM37APYyeRAsV2MxJRZeb0e',
    "failedLoginAttempts" = 0,
    "lockedUntil" = NULL
WHERE email = 'by-okan@live.com';
