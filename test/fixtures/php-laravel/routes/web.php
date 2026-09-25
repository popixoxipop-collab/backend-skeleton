<?php
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\UserController;

Route::get('/health', function () { return 'ok'; });
Route::prefix('admin')->group(function () {
    Route::get('/users', [UserController::class, 'index']);
});
