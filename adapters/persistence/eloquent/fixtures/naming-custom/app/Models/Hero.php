<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Hero extends Model
{
    public const PREFIX = 'acme_';

    protected $table = self::PREFIX . 'heroes';
    protected $primaryKey = 'id';
}
