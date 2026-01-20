UPDATE public.users
SET password = '$2b$12$HO2Yd1nywF33DISPSb18PuxYjKi905qqGS9wkFPcn.kDwIR00fWma',
    "failedLoginAttempts" = 0,
    "lockedUntil" = NULL
WHERE email IN ('by-okan@live.com', 'okan@suderra.com');
