UPDATE public.users
SET password = '$2b$12$A0dMbjJm.CwhId01n12hLu1SlRh5rbJwZ3Sl5bE3JHgEwIqVZK4VC',
    "failedLoginAttempts" = 0,
    "lockedUntil" = NULL
WHERE email IN ('by-okan@live.com', 'okan@suderra.com');
