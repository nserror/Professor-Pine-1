const log = require('loglevel').getLogger('PartyManager'),
  settings = require('../data/settings'),
  storage = require('node-persist'),
  {PartyType} = require('./constants'),
	Region = require('./region'),
  TimeType = require('../types/time'),
  Helper = require('./helper');

let Raid,
  RaidTrain;

process.nextTick(() => {
  Raid = require('./raid');
  RaidTrain = require('./train');
});

class PartyManager {
  constructor() {
    let lastIntervalTime = moment().valueOf(),
      lastIntervalDay = moment().dayOfYear();

    // loop to clean up raids periodically
    this.update = setInterval(() => {
      const nowMoment = moment(),
        nowDay = nowMoment.dayOfYear(),
        now = nowMoment.valueOf(),
        startClearTime = now + (settings.startClearTime * 60 * 1000),
        deletionGraceTime = settings.deletionGraceTime * 60 * 1000,
        deletionTime = now + (settings.deletionWarningTime * 60 * 1000),
        lastIntervalRunTime = lastIntervalTime - settings.cleanupInterval;

      Object.entries(this.parties)
        .filter(([channelId, party]) => party.type === PartyType.RAID)
        .forEach(async ([channelId, party]) => {
          if ((party.hatchTime && now > party.hatchTime && party.hatchTime > lastIntervalTime) ||
            nowDay !== lastIntervalDay) {
            party.refreshStatusMessages()
              .catch(err => log.error(err));
          }

          if ((now > party.hatchTime && party.hatchTime > lastIntervalRunTime)
              || (now > party.endTime && party.endTime > lastIntervalRunTime)) {
            const newChannelName = party.generateChannelName();

            await this.getChannel(party.channelId)
              .then(channelResult => {
                if (channelResult.ok) {
                  party.refreshStatusMessages()
                    .catch(err => log.error(err));

                  return channelResult.channel.setName(newChannelName);
                }
              })
              .catch(err => log.error(err));
          }

          party.groups
            .forEach(async group => {
              if (group.startTime) {
                if (group.startClearTime && (now > group.startClearTime)) {
                  // clear out start time
                  delete group.startTime;
                  delete group.startClearTime;

                  await party.persist();

                  party.refreshStatusMessages()
                    .catch(err => log.error(err));

                  // ask members if they finished party
                  party.setPresentAttendeesToComplete(group.id)
                    .catch(err => log.error(err));
                } else if (!group.startClearTime && now > group.startTime) {
                  group.startClearTime = startClearTime;

                  await party.persist();

                  party.refreshStatusMessages()
                    .catch(err => log.error(err));
                }
              }
            });

          if (((party.endTime !== TimeType.UNDEFINED_END_TIME && now > party.endTime + deletionGraceTime) || now > party.lastPossibleTime + deletionGraceTime) &&
            !party.deletionTime) {
            // party's end time is set (or last possible time) in the past, even past the grace period,
            // so schedule its deletion
            party.deletionTime = deletionTime;

            party.sendDeletionWarningMessage();
            await party.persist();
          }
          if (party.deletionTime && now > party.deletionTime) {
            party.delete();
          }

          lastIntervalTime = now;
          lastIntervalDay = nowDay;
        });
    }, settings.cleanupInterval);
  }

  async initialize() {
    this.activeStorage = storage.create({
      dir: 'parties/active',
      forgiveParseErrors: true
    });
    await this.activeStorage.init();

    this.completedStorage = storage.create({
      dir: 'parties/complete',
      forgiveParseErrors: true
    });
    await this.completedStorage.init();

    // maps channel ids to raid / train party info for that channel
    this.parties = Object.create(null);

    await this.activeStorage
      .forEach(entry => {
        if (!entry) {
          return;
        }

        const channelId = entry.key,
          party = entry.value;

        if (party.type) {
          switch (party.type) {
            case PartyType.RAID:
              this.parties[channelId] = new Raid(party);
              break;

            case PartyType.RAID_TRAIN:
              this.parties[channelId] = new RaidTrain(party);
              break;

            case PartyType.MEETUP:
              this.parties[channelId] = new Meetup(party);
              break;
          }
        }
      });

		this.loadGymCache();
  }

  shutdown() {
    this.client.destroy();
  }

  setClient(client) {
    this.client = client;
		this.regionChannels = [];
		this.loadRegionChannels();

    client.on('message', message => {
      if (message.author.id !== client.user.id) {
        // if this is a raid channel that's scheduled for deletion, trigger deletion warning message
        const raid = this.getParty(message.channel.id);

        if (!!raid && !!raid.deletionTime) {
          raid.sendDeletionWarningMessage();
        }
      }
    });
  }

  async loadRegionChannels() {
		var that = this;
		Region.checkRegionsExist().then(success => {
			if(success) {
				that.client.channels.forEach(async function(channel) {
					const region = await Region.getRegionsRaw(channel.id).catch(error => false);
					if(region) {
						that.regionChannels.push(channel.id);
					}

					let last = that.client.channels.array().slice(-1)[0];
					if(channel.id == last.id) {
						that.clearOldRegionChannels();
					}
				})
			}
		}).catch(error => console.log(error))
	}

	async clearOldRegionChannels() {
		var that = this;
		Region.checkRegionsExist().then(async function(success) {
			if(success) {
				const regions = await Region.getAllRegions().catch(error => console.log("PROBLEM"));
				console.log("TOTAL REGIONS FOUND: " + regions.length)
				const deleted = await Region.deleteRegionsNotInChannels(that.regionChannels).catch(error => console.log("PROBLEM"));
				console.log("DELETED " + deleted.affectedRows + " REGIONS NOT TIED TO CHANNELS")
			}
		}).catch(error => console.log(error))
	}

	cacheRegionChannel(channel) {
		this.regionChannels.push(channel);
	}

	gymIsCached(gym_id) {

		if(this.gymCache) {
			for (var i = 0; i < this.gymCache.length; i++) {
				var gym = this.gymCache[i];
				if(gym.id === gym_id) {
					return true;
				}
			}
		}

		return false;
	}

	async loadGymCache() {
		if(!this.gymCache) {
			this.gymCache = [];
		}
		var that = this;
		Object.entries(this.parties)
      .filter(([channelId, party]) => party.type === PartyType.RAID)
			.forEach(async function([channel_id, party]){
				if(!that.gymIsCached(party.gymId)) {
          console.log(party)
					const gym = await Region.getGym(party.gymId)
					that.gymCache.push(gym);
				}
			});
	}

	cacheGym(gym) {
		if(!this.gymCache) {
			this.gymCache = [];
		}
		if(!this.gymIsCached(gym.id)) {
			this.gymCache.push(gym);
		}

		console.log(this.gymCache)
	}

	getCachedGym(gym_id) {

		if(this.gymIsCached(gym_id)) {
			for (var i = 0; i < this.gymCache.length; i++) {
				var gym = this.gymCache[i];
				if(gym.id === gym_id) {
					return gym;
				}
			}
		} else {
			console.log("not cached")
		}

		return null;
	}

	getRaidChannelCache() {
		return this.regionChannels
	}

	channelCanRaid(channel_id) {
		return this.regionChannels.indexOf(channel_id) > -1;
	}

	categoryHasRegion(category) {
        const children = Helper.childrenForCategory(category)
        if(children.length > 0) {
            for(var i=0;i<children.length;i++) {
                const child = children[i]
                if(this.channelCanRaid(child.id)) {
                    return true
                }
            }
        } else {
            return false
        }
    }

  async getMember(channelId, memberId) {
    const party = this.getParty(channelId),
      channel = (await this.getChannel(channelId)).channel,
      member = channel.guild.members.get(memberId);

    if (!!member) {
      return Promise.resolve({member, ok: true});
    }

    log.warn(`Removing nonexistent member ${memberId} from raid`);
    party.removeAttendee(memberId);

    return Promise.resolve({error: new Error(`Member ${memberId} does not exist!`), ok: false});
  }

  findRaid(gymId, isExclusive) {
    return Object.values(this.parties)
      .filter(party => party.type === PartyType.RAID)
      .filter(raid => (!!raid.isExclusive) === isExclusive)
      .find(raid => raid.gymId === gymId);
  }

  raidExistsForGym(gymId, isExclusive) {
    return Object.values(this.parties)
      .filter(party => party.type === PartyType.RAID)
      .filter(raid => (!!raid.isExclusive) === isExclusive)
      .map(raid => raid.gymId)
      .includes(gymId);
  }

  getChannel(channelId) {
    try {
      const channel = this.client.channels.get(channelId);

      if (!channel) {
        if (this.validParty(channelId)) {
          log.warn(`Deleting raid for nonexistent channel ${channelId}`);

          this.deleteParty(channelId, false);
        }

        return Promise.resolve({error: new Error('Channel does not exist'), ok: false});
      }

      return Promise.resolve({channel, ok: true});
    } catch (err) {
      log.error(err);
      return Promise.resolve({error: err, ok: false});
    }
  }

  async getMessage(messageCacheId) {
    try {
      const [channelId, messageId] = messageCacheId.split(':');

      return this.getChannel(channelId)
        .then(async channel => {
          if (!channel.ok) {
            const party = this.getParty(channelId);

            if (!!party) {
              log.warn(`Deleting nonexistent message ${messageId} from ${party.name} ${channelId}`);
              party.messages.splice(party.messages.indexOf(messageCacheId), 1);

              await party.persist();
            } else {
              // try to find message in parties list that matches this message since that's what this non-existent message
              // most likely is from
              Object.values(this.parties)
                .filter(party => party.messages.indexOf(messageCacheId) !== -1)
                .forEach(async party => {
                  log.warn(`Deleting nonexistent message ${messageId} from ${party.name} ${party.channelId}`);
                  party.messages.splice(party.messages.indexOf(messageCacheId), 1);

                  await party.persist();
                });
            }
          } else {
            const message = await channel.channel.messages.fetch(messageId);
            return {message: message, ok: true};
          }
        })
        .catch(err => {
          log.error(err);
          return Promise.resolve({error: new Error('Message does not exist'), ok: false});
        });
    } catch (err) {
      log.error(err);
      return Promise.resolve({error: err, ok: false});
    }
  }

  async persistParty(party) {
    await this.activeStorage.setItem(party.channelId, party)
      .catch(err => log.error(err));
  }

  deleteParty(channelId, deleteChannel = true) {
    const party = this.getParty(channelId);

    // delete all messages for party, with defensive check first that raid actually has any
    if (Array.isArray(party.messages)) {
      party.messages
        .filter(messageCacheId => messageCacheId.split(':')[0] !== channelId)
        .forEach(messageCacheId => this.getMessage(messageCacheId)
          .then(messageResult => {
            if (messageResult.ok) {
              messageResult.message.delete()
                .catch(err => log.error(err));
            }
          })
          .catch(err => log.error(err)));
    }

    const channelDeletePromise = deleteChannel ?
      this.getChannel(channelId)
        .then(channelResult => {
          return channelResult.ok ?
            channelResult.channel.delete()
              .catch(err => log.error(err)) :
            Promise.resolve(true);
        }) :
      Promise.resolve(true);

    channelDeletePromise
      .then(result => {
        // delete messages from raid object before moving to completed raid
        // storage as they're no longer needed
        delete party.messages;
        delete party.messagesSinceDeletionScheduled;

        if (party.type === PartyType.RAID) {
          // TODO: this is only really right for raids, not trains or generic meetups, so rethink / revisit this
          this.completedStorage.getItem(party.gymId.toString())
            .then(gymRaids => {
              if (!gymRaids) {
                gymRaids = [];
              }
              gymRaids.push(party);
              return this.completedStorage.setItem(party.gymId.toString(), gymRaids);
            })
            .then(result => this.activeStorage.removeItem(channelId))
            .catch(err => log.error(err));
        } else {
          this.activeStorage.removeItem(channelId)
            .catch(err => log.error(err));
        }

        delete this.parties[channelId];
      })
      .catch(err => log.error(err));
  }

  validParty(channelId, types = undefined) {
    const party = this.parties[channelId];

    return !!party && (types !== undefined ?
      types.indexOf(party.type) >= 0 :
      true);
  }

  getParty(channelId) {
    return this.parties[channelId];
  }

  getAllParties(channelId, type) {
    return Object.values(this.parties)
      .filter(party => party.sourceChannelId === channelId)
      .filter(party => party.type === type);
  }

  getCreationChannelName(channelId) {
    return this.validParty(channelId) ?
      this.getChannel(this.getParty(channelId).sourceChannelId)
        .then(channelResult => channelResult.ok ?
          channelResult.channel.name :
          '')
        .catch(err => {
          log.error(err);
          return '';
        }) :
      this.getChannel(channelId)
        .then(channelResult => channelResult.ok ?
          channelResult.channel.name :
          '')
        .catch(err => {
          log.error(err);
          return '';
        });
  }

  addMessage(channelId, message, pin = false) {
    const party = this.getParty(channelId);

    if (!party.messages) {
      party.messages = [];
    }

    const messageCacheId = `${message.channel.id.toString()}:${message.id.toString()}`;

    party.messages.push(messageCacheId);

    this.persistParty(party);

    if (pin) {
      return message.pin();
    }
  }
}

module.exports = new PartyManager();
