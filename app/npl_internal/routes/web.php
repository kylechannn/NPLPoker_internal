<?php

use Illuminate\Support\Facades\Route;

// Route::view, not a closure — closures cannot be route:cached and the
// Go host runs `artisan optimize` at boot.
Route::view('/', 'welcome');
