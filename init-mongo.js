db = db.getSiblingDB('admin');
db.createUser({
  user: 'root',
  pwd: 'example',
  roles: [
    {
      role: 'readWrite',
      db: 'riot_games'
    },
    {
      role: 'dbAdmin',
      db: 'admin'
    }
  ]
});
