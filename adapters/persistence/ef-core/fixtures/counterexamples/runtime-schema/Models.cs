using System;
using Microsoft.EntityFrameworkCore;

namespace T00.EfCorePlan.RuntimeSchema;

public sealed class Invoice
{
    public long Id { get; set; }
}

// The physical schema depends on process configuration and must not be guessed statically.
public sealed class RuntimeSchemaContext : DbContext
{
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var schema = Environment.GetEnvironmentVariable("TENANT_SCHEMA") ?? "public";
        modelBuilder.Entity<Invoice>().ToTable("invoices", schema);
    }
}
